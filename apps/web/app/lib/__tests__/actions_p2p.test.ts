import { flush } from './helpers/test_clock'
import { CAN_ALL } from '../channel_perms'
import { moderationOf } from '../place/moderation'
import { shownPeer } from './shown_peer'
import { PURGE_ALL } from '../durations'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  ArrowRight,
  Bell,
  BellOff,
  CheckCheck,
  Clock,
  Copy,
  Crown,
  Download,
  Eraser,
  ExternalLink,
  Forward,
  Hash,
  IdCard,
  LockOpen,
  LogOut,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Reply,
  Server,
  Settings,
  Trash2,
  UserPlus,
  Volume2,
  X,
} from 'lucide-react'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems, openActionMenu, openChoiceMenu } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { memberMenu } from '../../components/p2p/p2p_server_view'
import { roleItems, roleMenuItems } from '../../components/p2p/p2p_server_roles'
import { allActions } from '../actions/registry'
import type { ChatFacts, Target } from '../actions/types'
import { P2P_IP_HINT } from '../call_choice'
import { emptyLayout, type Folder } from '../nav_layout'
import { EMPTY_NOTIFY, MUTE_CHOICES, setMute, type NotifyPrefs } from '../notify'

import { b64u } from '../p2p/canonical'
import { textHash, type HeldOriginal } from '../forward_pill'
import type { Attachment } from '../p2p/content'
import type { Contact } from '../p2p/contacts'
import type { P2pMessage } from '../p2p/dm'
import { keyId, newKeyPair } from '../p2p/keys'
import type { MemberView, RoleView, ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { setSharing, sharing } from '../platform'
import { useStore, type ConfirmRequest, type ContextMenuItem } from '../store'
import type { Message } from '../types'

const initial = useStore.getState()
const p2pInitial = shownPeer().useP2p.getState()
const realSharing = sharing()

beforeAll(registerAppActions)

afterEach(() => {
  setSharing(realSharing)
  useStore.setState(initial, true)
  shownPeer().useP2p.setState(p2pInitial, true)
})

const ME = 'IK_ME'.padEnd(43, 'a')
const BOB = 'IK_BOB'.padEnd(43, 'b')
const CAROL = 'IK_CAROL'.padEnd(43, 'c')
const DAVE = 'IK_DAVE'.padEnd(43, 'd')
const SRV = 'srv-room'

const contact = (ik: string, name: string, state: Contact['state'] = 'mutual') =>
  ({ ik, name, petname: null, state, certs: [], intros: [], verified: false }) as unknown as Contact

const member = (ik: string, name: string, over: Partial<MemberView> = {}): MemberView => ({
  ik,
  m: 'join',
  name,
  owner: false,
  online: true,
  contact: true,
  below: true,
  waits: false,
  myInvite: false,
  unban: false,
  roles: [],
  top: null,
  ...over,
})

const role = (id: string, name: string, over: Partial<RoleView> = {}): RoleView => ({
  id,
  name,
  color: null,
  pos: 0,
  bits: 0,
  holders: 0,
  below: true,
  held: false,
  icon: null,
  hoist: true,
  tint: true,
  dpos: null,
  ...over,
})

// Top outranks us; Mods, Helpers (held back by a channel) and Fans are below us.
const ROLES = [
  role('r0', 'Top', { below: false }),
  role('r1', 'Mods', { holders: 2 }),
  role('r2', 'Helpers', { held: true }),
  role('r3', 'Fans'),
]

const MEMBERS = {
  me: member(ME, 'Me', { below: false }),
  bob: member(BOB, 'Bob', { owner: true, below: false }),
  carol: member(CAROL, 'Carol', { roles: ['r1'] }),
  dave: member(DAVE, 'Dave', { m: 'invite', myInvite: true }),
}

const TEXT = {
  id: 'c1',
  name: 'general',
  kind: 'text',
  pos: 0,
  send: true,
  exempt: false,
  perms: 0n,
  over: {},
  everyoneSees: true,
  cat: null as string | null,
  sync: false,
}
const VOICE = {
  id: 'v1',
  name: 'Lounge',
  kind: 'voice',
  pos: 1,
  send: true,
  exempt: false,
  perms: 0n,
  over: {},
  everyoneSees: true,
  cat: null as string | null,
  sync: false,
}

// Book club, owned by Bob; we hold `perms` in it.
const server = (over: Partial<ServerView> = {}): ServerView =>
  ({
    id: SRV,
    name: 'Book club',
    me: 'join',
    owner: BOB,
    owners: [BOB],
    perms: 0,
    rank: [Infinity, ''],
    categories: [],
    separators: [],
    roles: ROLES,
    channels: [TEXT, VOICE],
    members: Object.values(MEMBERS),
    chans: {},
    voice: {},
    upgraded: false,
    changeProfile: true,
    ...over,
  }) as ServerView

const MOD = P.Kick | P.Ban | P.ManageRoles | P.ManageMessages

const state = (o: { notify?: NotifyPrefs; streamer?: boolean } = {}) => {
  useStore.setState({ notifyPrefs: o.notify ?? EMPTY_NOTIFY, streamer: !!o.streamer })
  shownPeer().useP2p.setState({
    enabled: true,
    me: ME,
    contacts: [contact(BOB, 'Bob'), contact(CAROL, 'Carol', 'incoming')],
    layout: emptyLayout,
    voice: null,
  })
}

const items = (target: Target) => menuItems(ctxFor(useStore.getState(), target, 'menu'))
const labels = (target: Target) => items(target).map(i => i.label)
const row = (target: Target, label: string) => items(target).find(i => i.label === label)
const shape = (i: ContextMenuItem) => [i.label, !!i.danger, i.icon ?? null]

const onServer = (v: ServerView, folder: string | null = null, at = 0): Target => ({
  kind: 'p2p_server',
  v,
  folder,
  at,
})
const onChannel = (v: ServerView, ch = TEXT): Target => ({ kind: 'p2p_channel', v, ch })
// A member row, with the room holding the member as the row shows them.
const onMember = (v: ServerView, m: MemberView): Target => {
  const members = [...(v.members ?? []).filter(x => x.ik !== m.ik), m]
  shownPeer().useP2p.setState(s => ({ servers: { ...s.servers, [v.id]: { ...v, members } } }))
  return { kind: 'p2p_member', v, m }
}
const onRole = (v: ServerView, r: RoleView): Target => ({ kind: 'p2p_role', v, r })

const settle = () => flush()

// What `syncWidens` answers in the recorded runs.
let widens: string[] = []

// What the rows did: confirms (accepted with their first choice), copies and P2P calls.
const recorder = () => {
  const calls: unknown[][] = []
  const openDialog = useStore.getState().openDialog
  useStore.setState({
    openDialog: d => {
      if (d.kind !== 'ban') return openDialog(d)
      const { ban, member } = moderationOf(d.place)
      const closes = ban.run(d.who, { seconds: 3600, reason: 'spam', purgeHours: PURGE_ALL })
      calls.push(['ban dialog', ban.title, member(d.who).get().name, ban.support.get(), closes])
    },
    askConfirm: (c: ConfirmRequest) => {
      calls.push(['confirm', c.title, c.body, c.confirm])
      c.action(c.choices?.[0]?.value ?? '')
    },
    muteScope: (scope, until) => void calls.push(['mute', scope, until === null ? null : 'later']),
    showToast: (...a: unknown[]) => void calls.push(['toast', ...a]),
    copyForwardClip: c => void calls.push(['clip', c.body, c.author?.display_name]),
  })
  setSharing({
    ...realSharing,
    copyText: async t => {
      calls.push(['copy', t])
      return true
    },
  })
  const spy = <T extends object>(name: string, obj: T, keys: (keyof T)[]) => {
    for (const k of keys)
      (obj as Record<string, unknown>)[k as string] = (...args: unknown[]) => {
        calls.push([
          `${name}.${String(k)}`,
          ...args.map(a => (a && typeof a === 'object' && 'h' in a ? a.h : a)),
        ])
        return Promise.resolve(
          k === 'ensureRoom'
            ? 'room-x'
            : k === 'forward'
              ? true
              : k === 'syncWidens'
                ? widens
                : null
        )
      }
  }
  const { p2pServer, p2pRail, p2pVoice, p2p, p2pDm, p2pThread, p2pFiles, p2pCall, p2pBadge } =
    shownPeer()
  const saved = {
    server: { ...p2pServer },
    rail: { ...p2pRail },
    voice: { ...p2pVoice },
    p2p: { ...p2p },
    dm: { ...p2pDm },
    thread: { ...p2pThread },
    files: { ...p2pFiles },
    call: { ...p2pCall },
    badge: { ...p2pBadge },
  }
  spy('server', p2pServer, [
    'open',
    'leave',
    'forget',
    'markAllRead',
    'markRead',
    'removeChannel',
    'openChannel',
    'kick',
    'ban',
    'withdraw',
    'transfer',
    'assignRole',
    'revokeRole',
    'moveRoles',
    'showRoles',
    'deleteRole',
    'unlockProfile',
    'deleteCategory',
    'editCategory',
    'editSeparator',
    'deleteSeparator',
    'placeChannel',
    'syncWidens',
    'syncChannel',
  ])
  spy('rail', p2pRail, ['move', 'ungroup'])
  spy('voice', p2pVoice, ['join', 'leave'])
  spy('p2p', p2p, ['openDialog', 'openHome'])
  spy('dm', p2pDm, [
    'openDm',
    'startReply',
    'startEdit',
    'pin',
    'remove',
    'jumpTo',
    'openPins',
    'ensureRoom',
    'forward',
  ])
  spy('thread', p2pThread, ['open'])
  spy('files', p2pFiles, ['save', 'download', 'cancel'])
  spy('call', p2pCall, ['start'])
  spy('badge', p2pBadge, ['recheck'])
  const restore = () => {
    Object.assign(p2pServer, saved.server)
    Object.assign(p2pRail, saved.rail)
    Object.assign(p2pVoice, saved.voice)
    Object.assign(p2p, saved.p2p)
    Object.assign(p2pDm, saved.dm)
    Object.assign(p2pThread, saved.thread)
    Object.assign(p2pFiles, saved.files)
    Object.assign(p2pCall, saved.call)
    Object.assign(p2pBadge, saved.badge)
  }
  return { calls, restore }
}

const run = async (item: ContextMenuItem | undefined) => {
  const rec = recorder()
  try {
    item?.action?.()
    await settle()
    await settle()
    return rec.calls
  } finally {
    rec.restore()
  }
}

describe("a P2P server's menu (rail tile and header)", () => {
  test('as a member: mark read dimmed, mute, notifications, settings, copy id, leave', () => {
    state()
    const list = items(onServer(server()))
    expect(list.map(shape)).toEqual([
      ['Mark as read', false, CheckCheck],
      ['Mute Server', false, BellOff],
      ['Notification settings', false, null],
      ['Server Settings', false, Settings],
      ['Edit Server Profile', false, IdCard],
      ['Copy Server ID', false, null],
      ['Leave Server', true, LogOut],
    ])
    expect(list[0].disabled).toBe(true)
    expect(list[1].submenu?.map(i => i.label)).toEqual(MUTE_CHOICES.map(c => c.label))
    expect(list[2].subtitle).toBe('Only @mentions')
  })

  test('as the owner with invite rights: Invite People before Server Settings', () => {
    state()
    const v = server({ owner: ME, owners: [ME], perms: 0x7fffffff })
    expect(labels(onServer(v))).toEqual([
      'Mark as read',
      'Mute Server',
      'Notification settings',
      'Invite People',
      'Server Settings',
      'Edit Server Profile',
      'Create Category',
      'Create Separator',
      'Copy Server ID',
      'Leave Server',
    ])
    expect(row(onServer(v), 'Invite People')?.icon).toBe(UserPlus)
  })

  test('inside a folder, muted, with unread news: unmute, mark read, remove from folder', async () => {
    state({ notify: setMute(EMPTY_NOTIFY, { kind: 'p2ps', room: SRV }, 'forever') })
    const v = server({ chans: { c1: { unread: 2, pings: 1, readSeq: 0 } } })
    const t = onServer(v, 'f1', 2)
    expect(labels(t)).toEqual([
      'Mark as read',
      'Unmute Server',
      'Notification settings',
      'Server Settings',
      'Edit Server Profile',
      'Copy Server ID',
      'Remove from folder',
      'Leave Server',
    ])
    const [read, unmute] = items(t)
    expect([read.disabled ?? false, unmute.icon, unmute.subtitle]).toEqual([
      false,
      Bell,
      'Muted until you turn it back on',
    ])
    expect(await run(read)).toEqual([['server.markAllRead', SRV]])
    expect(await run(unmute)).toEqual([['mute', { kind: 'p2ps', room: SRV }, null]])
    expect(await run(row(t, 'Remove from folder'))).toEqual([['rail.move', SRV, 3]])
  })

  test('leaving asks first and names the server unless streamer mode is on', async () => {
    state()
    const leave = () => row(onServer(server()), 'Leave Server')
    expect(await run(leave())).toEqual([
      [
        'confirm',
        'Leave Server',
        'Leave Book club? Someone who can invite has to let you in again.',
        'Leave',
      ],
      ['server.leave', SRV],
    ])
    state({ streamer: true })
    expect((await run(leave()))[0]).toContain(
      'Leave this server? Someone who can invite has to let you in again.'
    )
  })

  test('invited: leave; not a member: remove from this device', async () => {
    state()
    expect(labels(onServer(server({ me: 'invite' }))).slice(3)).toEqual([
      'Copy Server ID',
      'Leave Server',
    ])
    const gone = onServer(server({ me: 'leave' }))
    expect(labels(gone).slice(3)).toEqual(['Copy Server ID', 'Remove from this device'])
    const remove = row(gone, 'Remove from this device')!
    expect([remove.danger, remove.icon]).toEqual([true, undefined])
    expect(await run(remove)).toEqual([
      [
        'confirm',
        'Remove Server',
        "Remove Book club and everything of it from this device? You aren't a member any more, so it can't come back.",
        'Remove',
      ],
      ['server.forget', SRV],
    ])
  })

  test('copy and settings rows act on the server', async () => {
    state()
    const v = server({ perms: P.Invite })
    expect(await run(row(onServer(v), 'Copy Server ID'))).toEqual([['copy', SRV]])
    expect(await run(row(onServer(v), 'Server Settings'))).toEqual([
      ['p2p.openDialog', { kind: 'server_settings', room: SRV }],
    ])
    expect(await run(row(onServer(v), 'Invite People'))).toEqual([
      ['p2p.openDialog', { kind: 'server_invite', room: SRV }],
    ])
  })
})

describe("a P2P folder's menu", () => {
  test('color, edit and ungroup, and none of an instance folder rows', async () => {
    state()
    const folder: Folder = { id: 'p1', name: 'Fun', servers: [SRV], open: false }
    shownPeer().useP2p.setState({ layout: { ...emptyLayout, servers: [folder] } })
    const t: Target = { kind: 'folder', folder, p2p: true }
    expect(labels(t)).toEqual(['Folder color', 'Edit folder', 'Ungroup'])
    expect(await run(row(t, 'Edit folder'))).toEqual([
      ['p2p.openDialog', { kind: 'p2p_folder', id: 'p1' }],
    ])
    expect(await run(row(t, 'Ungroup'))).toEqual([['rail.ungroup', 'p1']])
    shownPeer().useP2p.setState({ layout: emptyLayout })
    expect(labels(t)).toEqual([])
  })
})

describe("a P2P channel's menu", () => {
  test('a text channel as a member: read, mute, notifications, copy id', () => {
    state()
    const list = items(onChannel(server()))
    expect(list.map(i => i.label)).toEqual([
      'Mark as read',
      'Mute Channel',
      'Notification settings',
      'Copy Channel ID',
    ])
    expect([list[0].disabled, list[2].subtitle]).toEqual([true, 'Server default (Only @mentions)'])
    expect(list[2].submenu?.[0]).toMatchObject({ label: 'Use server default', checked: true })
  })

  test('a text channel as a manager: edit and delete, delete asks first', async () => {
    state()
    const t = onChannel(server({ perms: P.ManageChannels }))
    expect(labels(t)).toEqual([
      'Mark as read',
      'Mute Channel',
      'Notification settings',
      'Edit Channel',
      'Permissions',
      'Delete Channel',
      'Copy Channel ID',
    ])
    expect(row(t, 'Delete Channel')?.danger).toBe(true)
    expect(await run(row(t, 'Edit Channel'))).toEqual([
      ['p2p.openDialog', { kind: 'server_settings', room: SRV, tab: 'channels' }],
    ])
    expect(await run(row(t, 'Permissions'))).toEqual([
      ['p2p.openDialog', { kind: 'perms', room: SRV, ch: 'c1' }],
    ])
    expect(await run(row(t, 'Delete Channel'))).toEqual([
      [
        'confirm',
        'Delete Channel',
        "Delete #general? Its messages stay on members' devices but can't be opened.",
        'Delete',
      ],
      ['server.removeChannel', SRV, 'c1'],
    ])
  })

  test('unread news can be marked read; a muted server says so under Mute Channel', async () => {
    state({ notify: setMute(EMPTY_NOTIFY, { kind: 'p2ps', room: SRV }, 'forever') })
    const t = onChannel(server({ chans: { c1: { unread: 0, pings: 1, readSeq: 0 } } }))
    const [read, mute] = items(t)
    expect([read.disabled ?? false, mute.subtitle]).toEqual([
      false,
      'Server muted until you turn it back on',
    ])
    expect(await run(read)).toEqual([['server.markRead', SRV, 'c1']])
    state({ notify: setMute(EMPTY_NOTIFY, { kind: 'p2pc', room: SRV, ch: 'c1' }, 'forever') })
    expect(row(onChannel(server()), 'Unmute Channel')?.subtitle).toBe(
      'Muted until you turn it back on'
    )
  })

  test('a voice channel: join or leave voice, then the manager rows and the id', async () => {
    state()
    const v = server({ perms: P.ManageChannels })
    const t = onChannel(v, VOICE)
    expect(labels(onChannel(server(), VOICE))).toEqual(['Join Voice', 'Copy Channel ID'])
    expect(labels(t)).toEqual([
      'Join Voice',
      'Edit Channel',
      'Permissions',
      'Delete Channel',
      'Copy Channel ID',
    ])
    expect(row(t, 'Join Voice')?.icon).toBe(Volume2)
    expect(await run(row(t, 'Join Voice'))).toEqual([['voice.join', SRV, 'v1']])
    expect((await run(row(t, 'Delete Channel')))[0]).toEqual([
      'confirm',
      'Delete Channel',
      'Delete Lounge?',
      'Delete',
    ])
    shownPeer().useP2p.setState({ voice: { room: SRV, ch: 'v1' } as never })
    const leave = row(t, 'Leave Voice')!
    expect(labels(t)[0]).toBe('Leave Voice')
    expect([leave.icon, leave.danger]).toEqual([Volume2, true])
    expect(await run(leave)).toEqual([['voice.leave']])
  })
})

describe("a P2P member's menu", () => {
  test('as a member: message and contact details for a contact, the key for everyone', async () => {
    state()
    const v = server()
    expect(labels(onMember(v, MEMBERS.me))).toEqual(['Edit Server Profile', 'Copy Identity Key'])
    expect(labels(onMember(v, MEMBERS.bob))).toEqual([
      'Message',
      'Contact details',
      'Copy Identity Key',
    ])
    expect(labels(onMember(v, MEMBERS.carol))).toEqual(['Contact details', 'Copy Identity Key'])
    expect(await run(row(onMember(v, MEMBERS.bob), 'Message'))).toEqual([
      ['p2p.openHome'],
      ['dm.openDm', BOB],
    ])
    expect(await run(row(onMember(v, MEMBERS.carol), 'Copy Identity Key'))).toEqual([
      ['copy', CAROL],
    ])
  })

  test('your own server profile opens from the server and from your own row while profiles are on', async () => {
    state()
    const v = server()
    const open = [['p2p.openDialog', { kind: 'server_profile', room: SRV }]]
    expect(await run(row(onServer(v), 'Edit Server Profile'))).toEqual(open)
    expect(await run(row(onMember(v, MEMBERS.me), 'Edit Server Profile'))).toEqual(open)
    expect(labels(onMember(v, MEMBERS.carol))).not.toContain('Edit Server Profile')
    for (const off of [
      { profiles: 'off' as const },
      { upgraded: true },
      { readOnly: 'Read only' },
      { me: 'invite' as const },
    ]) {
      expect(labels(onServer(server(off)))).not.toContain('Edit Server Profile')
      expect(labels(onMember(server(off), MEMBERS.me))).not.toContain('Edit Server Profile')
    }
    expect(labels(onServer(server({ profiles: 'no_names' })))).toContain('Edit Server Profile')
  })

  test('a profile we may reset: reset opens its dialog, unlock shows only while a lock runs', async () => {
    state()
    const v = server({ perms: P.Kick })
    const plain = onMember(v, { ...MEMBERS.carol, resetProfile: true })
    expect(items(plain).map(i => [i.label, !!i.danger, i.icon ?? null])).toEqual([
      ['Contact details', false, null],
      ['Kick Carol', true, null],
      ['Reset Server Profile', true, Eraser],
      ['Copy Identity Key', false, null],
    ])
    expect(await run(row(plain, 'Reset Server Profile'))).toEqual([
      ['p2p.openDialog', { kind: 'profile_reset', room: SRV, ik: CAROL }],
    ])
    const locked = onMember(v, { ...MEMBERS.carol, resetProfile: true, profileLocked: true })
    expect(labels(locked)).toEqual([
      'Contact details',
      'Kick Carol',
      'Reset Server Profile',
      'Unlock Server Profile',
      'Copy Identity Key',
    ])
    expect(row(locked, 'Unlock Server Profile')?.icon).toBe(LockOpen)
    expect(await run(row(locked, 'Unlock Server Profile'))).toEqual([
      ['server.unlockProfile', SRV, CAROL],
    ])
    // A lock we may not lift, and a server that shows no profiles, offer neither.
    const theirs = onMember(v, { ...MEMBERS.carol, profileLocked: true })
    expect(labels(theirs)).toEqual(['Contact details', 'Kick Carol', 'Copy Identity Key'])
    const off = onMember(server({ perms: P.Kick, profiles: 'off' }), {
      ...MEMBERS.carol,
      resetProfile: true,
      profileLocked: true,
    })
    expect(labels(off)).toEqual(['Contact details', 'Kick Carol', 'Copy Identity Key'])
  })

  test('as a moderator owner: roles, kick, transfer and ban; transfer is danger', () => {
    state()
    const v = server({ perms: MOD, owner: ME, owners: [ME] })
    const list = items(onMember(v, MEMBERS.carol))
    expect(list.map(i => [i.label, !!i.danger])).toEqual([
      ['Contact details', false],
      ['Roles', false],
      ['Kick Carol', true],
      ['Transfer Ownership', true],
      ['Ban Carol', true],
      ['Copy Identity Key', false],
    ])
    expect(list[3].icon).toBe(Crown)
    expect(list[1].submenu?.map(i => [i.label, i.checked])).toEqual([
      ['Mods', true],
      ['Helpers', false],
      ['Fans', false],
    ])
    expect(labels(onMember(v, MEMBERS.dave))).toEqual([
      'Withdraw invite of Dave',
      'Ban Dave',
      'Copy Identity Key',
    ])
    expect(labels(onMember({ ...v, upgraded: true }, MEMBERS.carol))).not.toContain(
      'Transfer Ownership'
    )
  })

  test('kick, ban, withdraw and transfer ask first, with streamer-safe names', async () => {
    state({ streamer: true })
    const v = server({ perms: MOD, owner: ME, owners: [ME, BOB] })
    const carol = onMember(v, MEMBERS.carol)
    expect(labels(carol)).toContain('Kick Member')
    expect(await run(row(carol, 'Kick Member'))).toEqual([
      ['confirm', 'Kick Member', 'Kick this member? They can come back with a new invite.', 'Kick'],
      ['server.kick', SRV, CAROL],
    ])
    expect(await run(row(carol, 'Ban Member'))).toEqual([
      ['server.ban', SRV, CAROL, { wipe: true, reason: 'spam' }],
      ['ban dialog', 'Ban Member', 'this member', { timed: false, purge: 'all' }, true],
    ])
    const transfer = await run(row(carol, 'Transfer Ownership'))
    expect(transfer[0][2]).toContain('owned by this member.')
    expect(transfer[0][2]).toContain('Every co-owner must approve the transfer')
    expect(transfer[1]).toEqual(['server.transfer', SRV, CAROL])
    expect(await run(row(onMember(v, MEMBERS.dave), 'Withdraw Invite'))).toEqual([
      [
        'confirm',
        'Withdraw Invite',
        'This cancels the invite. If they already received it, they can still use it to join, now or later; ask a moderator to remove them.',
        'Withdraw',
      ],
      ['server.withdraw', SRV, DAVE],
    ])
  })

  test('the ban dialog closes once the ban is asked for, while the room has not synced', async () => {
    state({ streamer: true })
    const v = server({ perms: MOD, owner: ME, owners: [ME, BOB] })
    const rec = recorder()
    const { p2pServer } = shownPeer()
    const asked: unknown[] = []
    p2pServer.ban = (...a: unknown[]) => {
      asked.push(a)
      return new Promise<null>(() => {})
    }
    let closes: unknown
    useStore.setState({
      openDialog: d => {
        if (d.kind === 'ban')
          closes = moderationOf(d.place).ban.run(d.who, {
            seconds: null,
            reason: null,
            purgeHours: 0,
          })
      },
    })
    try {
      row(onMember(v, MEMBERS.carol), 'Ban Member')?.action?.()
      await settle()
      expect(closes).toBe(true)
      expect(asked).toEqual([[SRV, CAROL, { wipe: false }]])
    } finally {
      rec.restore()
    }
  })

  test('timing out is offered for a joined member below us where the room reads timeouts', () => {
    state()
    const v = server({ perms: P.TimeoutMembers, timeouts: true })
    expect(labels(onMember(v, MEMBERS.carol))).toEqual([
      'Contact details',
      'Time Out',
      'Copy Identity Key',
    ])
    const running = { ...MEMBERS.carol, timeoutUntil: Date.now() + 60_000 }
    expect(items(onMember(v, running)).map(i => [i.label, !!i.danger])).toEqual([
      ['Contact details', false],
      ['Change Timeout', false],
      ['Remove Timeout', false],
      ['Copy Identity Key', false],
    ])
    const over = { ...MEMBERS.carol, timeoutUntil: Date.now() - 1 }
    expect(labels(onMember(v, over))).not.toContain('Remove Timeout')
    for (const m of [MEMBERS.me, MEMBERS.bob, MEMBERS.dave])
      expect(labels(onMember(v, m)).join()).not.toContain('Time')
    expect(labels(onMember({ ...v, timeouts: undefined }, MEMBERS.carol))).not.toContain('Time Out')
    expect(labels(onMember({ ...v, perms: MOD }, MEMBERS.carol))).not.toContain('Time Out')
  })

  test('the timeout dialog closes once the timeout is asked for; removing asks the room', async () => {
    state({ streamer: true })
    const v = server({ perms: P.TimeoutMembers, timeouts: true })
    const rec = recorder()
    const { p2pServer } = shownPeer()
    const asked: unknown[][] = []
    p2pServer.timeout = (...a: unknown[]) => {
      asked.push(['timeout', ...a])
      return new Promise<null>(() => {})
    }
    p2pServer.untimeout = (...a: unknown[]) => {
      asked.push(['untimeout', ...a])
      return new Promise<null>(() => {})
    }
    const seen: unknown[] = []
    useStore.setState({
      openDialog: d => {
        if (d.kind !== 'timeout') return
        const { member, timeout, untimeout } = moderationOf(d.place)
        const shown = member(d.who).get()
        seen.push(shown.name, shown.timeout?.reason ?? null)
        seen.push(timeout(d.who, { seconds: 600, reason: 'spam' }))
        untimeout(d.who)
      },
    })
    try {
      const running = { ...MEMBERS.carol, timeoutUntil: Date.now() + 60_000, timeoutReason: 'old' }
      row(onMember(v, running), 'Change Timeout')?.action?.()
      row(onMember(v, running), 'Remove Timeout')?.action?.()
      await settle()
      expect(seen).toEqual(['this member', 'old', true])
      expect(asked).toEqual([
        ['timeout', SRV, CAROL, 600, 'spam'],
        ['untimeout', SRV, CAROL],
        ['untimeout', SRV, CAROL],
      ])
    } finally {
      rec.restore()
    }
  })

  test('a role choice gives or takes the role; taking your own asks first', async () => {
    state()
    const v = server({ perms: P.ManageRoles })
    const roles = row(onMember(v, MEMBERS.carol), 'Roles')!.submenu!
    expect(await run(roles[0])).toEqual([['server.revokeRole', SRV, CAROL, 'r1']])
    expect(await run(roles[1])).toEqual([['server.assignRole', SRV, CAROL, 'r2']])
    const mine = row(onMember(v, { ...MEMBERS.me, roles: ['r1'] }), 'Roles')!.submenu!
    expect(mine.map(i => i.label)).toEqual(['Mods'])
    expect(await run(mine[0])).toEqual([
      [
        'confirm',
        'Remove Role',
        "Remove Mods from yourself? You can't give it back to yourself.",
        'Remove',
      ],
      ['server.revokeRole', SRV, ME, 'r1'],
    ])
  })

  test('memberMenu and roleMenuItems stay as wrappers over the registry', () => {
    state()
    const v = server({ perms: MOD })
    expect(memberMenu(v, MEMBERS.carol).map(i => i.label)).toEqual(
      labels(onMember(v, MEMBERS.carol))
    )
    expect(roleMenuItems(v, MEMBERS.carol).map(i => i.label)).toEqual(['Mods', 'Helpers', 'Fans'])
    expect(roleMenuItems(server(), MEMBERS.carol)).toEqual([])
  })

  test("the settings member row's Roles button opens the role choices as the menu", () => {
    state()
    const v = server({ perms: P.ManageRoles })
    openChoiceMenu(5, 6, 'p2p_member_roles', onMember(v, MEMBERS.carol), { header: 'card' })
    const open = useStore.getState().contextMenu
    expect([open?.x, open?.y, open?.header]).toEqual([5, 6, 'card'])
    expect(open?.items.map(i => [i.label, i.checked])).toEqual([
      ['Mods', true],
      ['Helpers', false],
      ['Fans', false],
    ])
    useStore.getState().closeContextMenu()
    openChoiceMenu(5, 6, 'p2p_member_roles', onMember(server(), MEMBERS.carol))
    expect(useStore.getState().contextMenu).toBe(null)
  })
})

describe("a P2P role's menu", () => {
  test('first, middle and last movable roles; a held role needs Manage channels to delete', () => {
    state()
    const v = server({ perms: P.ManageRoles })
    const [top, mods, helpers, fans] = ROLES
    expect(labels(onRole(v, top))).toEqual([])
    expect(labels(onRole(v, mods))).toEqual(['Move Down', 'Show Lower', 'Delete Role'])
    expect(labels(onRole(v, helpers))).toEqual([
      'Move Up',
      'Move Down',
      'Show Higher',
      'Show Lower',
    ])
    expect(labels(onRole(v, fans))).toEqual(['Move Up', 'Show Higher', 'Delete Role'])
    expect(labels(onRole(server({ perms: P.ManageRoles | P.ManageChannels }), helpers))).toEqual([
      'Move Up',
      'Move Down',
      'Show Higher',
      'Show Lower',
      'Delete Role',
    ])
    expect(labels(onRole(server(), mods))).toEqual([])
    expect(row(onRole(v, fans), 'Delete Role')?.danger).toBe(true)
  })

  test('moving and deleting', async () => {
    state()
    const v = server({ perms: P.ManageRoles })
    const [, mods, , fans] = ROLES
    expect(await run(row(onRole(v, fans), 'Move Up'))).toEqual([
      [
        'server.moveRoles',
        SRV,
        [
          { role: 'r0', pos: 4096 },
          { role: 'r1', pos: 3072 },
          { role: 'r3', pos: 2048 },
          { role: 'r2', pos: 1024 },
        ],
      ],
    ])
    expect(await run(row(onRole(v, fans), 'Show Higher'))).toEqual([
      [
        'server.showRoles',
        SRV,
        [
          { role: 'r1', dpos: -1024 },
          { role: 'r3', dpos: -2048 },
          { role: 'r2', dpos: -3072 },
        ],
      ],
    ])
    const placed = server({
      perms: P.ManageRoles,
      roles: ROLES.map(r => (r.id === 'r2' ? { ...r, dpos: 5 } : r)),
    })
    expect(labels(onRole(placed, fans))).toContain('Show in Role Order')
    expect(await run(row(onRole(placed, fans), 'Show in Role Order'))).toEqual([
      ['server.showRoles', SRV, [{ role: 'r2', dpos: null }]],
    ])
    const above = server({
      perms: P.ManageRoles,
      roles: ROLES.map(r => (r.id === 'r0' ? { ...r, dpos: 5 } : r)),
    })
    expect(labels(onRole(above, fans))).not.toContain('Show in Role Order')
    const both = (top: number) =>
      server({
        perms: P.ManageRoles,
        roles: ROLES.map(r =>
          r.id === 'r0' ? { ...r, dpos: top } : r.id === 'r2' ? { ...r, dpos: 99_999 } : r
        ),
      })
    expect(await run(row(onRole(both(100_000), fans), 'Show in Role Order'))).toEqual([
      ['server.showRoles', SRV, [{ role: 'r2', dpos: null }]],
    ])
    expect(labels(onRole(both(-100_000), fans))).not.toContain('Show in Role Order')
    expect(await run(row(onRole(v, mods), 'Delete Role'))).toEqual([
      ['confirm', 'Delete Role', 'Delete Mods? Members who have it lose it.', 'Delete'],
      ['server.deleteRole', SRV, 'r1'],
    ])
    expect((await run(roleItems(v, fans).find(i => i.label === 'Delete Role')))[0]).toEqual([
      'confirm',
      'Delete Role',
      'Delete Fans?',
      'Delete',
    ])
  })
})

test('P2P server, channel, member and role rows stay out of the palette', () => {
  state()
  shownPeer().useP2p.setState({
    servers: { [SRV]: server({ perms: 0x7fffffff, owner: ME, owners: [ME] }) },
  })
  const ids = new Set(paletteCommands(paletteCtx(useStore.getState())).map(r => r.id))
  const added = allActions()
    .map(a => a.id)
    .filter(id => /^p2p_(server|channel|member|role|folder)_/.test(id))
  expect(added.length).toBeGreaterThan(25)
  expect(added.filter(id => ids.has(id))).toEqual([])
  for (const a of allActions().filter(x => added.includes(x.id))) expect(a.scope).toBe('p2p')
})

test('the member list menu opens at the pointer with its header', () => {
  state()
  openActionMenu(7, 8, onMember(server(), MEMBERS.bob), { header: 'card' })
  const open = useStore.getState().contextMenu
  expect([open?.x, open?.y, open?.header, open?.items.length]).toEqual([7, 8, 'card', 3])
})

// ----- Chats: messages, pin lines, calls, account badges -----

const TS = 1_800_000_000_000

const msg = (over: Partial<P2pMessage> = {}): P2pMessage => ({
  id: 'm1',
  sender: BOB,
  ts: TS,
  sentTs: TS,
  sortKey: 'm1',
  seq: 1,
  body: 'hello there',
  reply: null,
  mentions: [],
  fwd: null,
  att: [],
  edited: null,
  reactions: [],
  pinned: null,
  late: false,
  pending: false,
  failed: false,
  call: null,
  ...over,
})

const shown = { id: 7, created_at: TS / 1000 } as Message

const facts = (over: Partial<ChatFacts> = {}): ChatFacts => ({
  draftKey: 'room-d',
  canAct: true,
  can: CAN_ALL,
  mayPin: false,
  mayDelete: () => false,
  forwardSkip: CAROL,
  threads: false,
  ownName: ik => (ik === BOB ? 'Bob Own' : 'Me Own'),
  ...over,
})

const onMessage = (p: P2pMessage, chat = facts()): Target => ({
  kind: 'p2p_message',
  p,
  m: shown,
  chat,
})

const chatState = () => {
  state()
  shownPeer().useP2p.setState({
    contacts: [contact(BOB, 'Bob'), contact(CAROL, 'Carol'), contact(DAVE, 'Dave', 'outgoing')],
    files: {},
  })
}

const att = (h: string, name: string): Attachment => ({
  h,
  size: 10,
  blocks: 1,
  name,
  mime: 'text/plain',
})

const file = (state: string, holders = 1) => ({
  state,
  got: 0,
  total: 1,
  holders,
  type: null,
  error: null,
  own: false,
  paused: null,
})

describe("a P2P message's menu", () => {
  test("another's message: reply, forward, copies", async () => {
    chatState()
    const list = items(onMessage(msg()))
    expect(list.map(shape)).toEqual([
      ['Reply', false, Reply],
      ['Forward', false, Forward],
      ['Copy Text', false, Copy],
      ['Copy Timestamp', false, Clock],
      ['Copy Message ID', false, Hash],
    ])
    expect(list[1].submenu?.map(i => [i.label, i.icon ?? null])).toEqual([
      ['Bob', null],
      ['Copy for forwarding', Copy],
    ])
    expect(await run(list[0])).toEqual([['dm.startReply', 'room-d', 'm1']])
    expect(await run(list[2])).toEqual([['copy', 'hello there']])
    expect(await run(list[3])).toEqual([['copy', '<t:1800000000:F>']])
    expect(await run(list[4])).toEqual([['copy', 'm1']])
  })

  test('forwarding sends to a contact under the sender’s own name, or copies it', async () => {
    chatState()
    const forward = row(onMessage(msg()), 'Forward')!.submenu!
    expect(await run(forward[0])).toEqual([
      ['dm.ensureRoom', BOB],
      ['dm.forward', 'room-x', { name: 'Bob Own', ts: TS, body: 'hello there', src: { dm: true } }],
      ['toast', 'Forwarded to', 'Bob', { local: 'main', name: '', ik: null }],
    ])
    expect(await run(forward[1])).toEqual([['clip', 'hello there', 'Bob Own']])
  })

  test('a forwarded copy opens its original and its server where this identity holds it', async () => {
    chatState()
    shownPeer().useP2p.setState({ servers: { [SRV]: server() } })
    const ev = b64u(new Uint8Array(32).fill(5))
    const copy = msg({
      fwd: { name: 'Zed', ts: TS, body: 'q', ev, src: { rn: 'Old club', cn: 'old' } },
    })
    const app = shownPeer()
    const real = { eventPlace: app.eventPlace, p2pOpenAt: app.p2pOpenAt }
    const held = (room: string, ch: string | null, body = 'q'): HeldOriginal => ({
      room,
      ch,
      sender: BOB,
      ts: [TS],
      texts: [textHash(body)],
      atts: [],
    })
    let found: HeldOriginal | null = null
    const opened: unknown[][] = []
    Object.assign(app, {
      eventPlace: (id: string) => (id === ev ? found : undefined),
      p2pOpenAt: async (...args: unknown[]) => void opened.push(args),
    })
    try {
      expect(labels(onMessage(copy))).not.toContain('Open original message')
      found = held(SRV, 'c1', 'not what the copy says')
      expect(labels(onMessage(copy))).not.toContain('Open original message')
      found = held(SRV, 'c1')
      expect(items(onMessage(copy)).map(shape).slice(0, 4)).toEqual([
        ['Reply', false, Reply],
        ['Forward', false, Forward],
        ['Open original message', false, ExternalLink],
        ['Open server', false, Server],
      ])
      expect(await run(row(onMessage(copy), 'Open server'))).toEqual([['server.open', SRV]])
      expect(await run(row(onMessage(copy), 'Open original message'))).toEqual([])
      expect(opened).toEqual([[SRV, 'c1', ev]])
      found = held('dm-room', null)
      expect(labels(onMessage(copy)).slice(2, 4)).toEqual(['Open original message', 'Copy Text'])
      found = held(SRV, 'gone')
      expect(labels(onMessage(copy))).not.toContain('Open original message')
    } finally {
      Object.assign(app, real)
    }
  })

  test('without the right to act: forward and copies only, and no header row of reactions', () => {
    chatState()
    expect(labels(onMessage(msg(), facts({ canAct: false })))).toEqual([
      'Forward',
      'Copy Text',
      'Copy Timestamp',
      'Copy Message ID',
    ])
    expect(
      labels(onMessage(msg({ archived: true }), facts({ mayPin: true, threads: true })))
    ).toEqual(['Forward', 'Copy Text', 'Copy Timestamp', 'Copy Message ID'])
  })

  test('your own message in a channel you moderate: edit, thread, unpin and delete', async () => {
    chatState()
    const chat = facts({ mayPin: true, mayDelete: () => true, threads: true })
    const t = onMessage(msg({ sender: ME, pinned: 5 }), chat)
    expect(items(t).map(shape)).toEqual([
      ['Reply', false, Reply],
      ['Edit Message', false, Pencil],
      ['Forward', false, Forward],
      ['Create thread', false, MessageSquareText],
      ['Unpin Message', false, PinOff],
      ['Delete Message', true, Trash2],
      ['Copy Text', false, Copy],
      ['Copy Timestamp', false, Clock],
      ['Copy Message ID', false, Hash],
    ])
    expect(await run(row(t, 'Edit Message'))).toEqual([['dm.startEdit', 'room-d', 'm1']])
    expect(await run(row(t, 'Create thread'))).toEqual([['thread.open', 'm1']])
    expect(await run(row(t, 'Unpin Message'))).toEqual([['dm.pin', 'm1', false]])
    expect(await run(row(t, 'Delete Message'))).toEqual([
      [
        'confirm',
        'Delete Message',
        'Delete this message? It is removed here now, and on the other device the next time you are both online.',
        'Delete',
      ],
      ['dm.remove', 'm1'],
    ])
    const other = onMessage(msg({ replies: 2 }), chat)
    expect(labels(other).slice(2, 4)).toEqual(['View thread', 'Pin Message'])
    expect(row(other, 'Pin Message')?.icon).toBe(Pin)
    expect(await run(row(other, 'Pin Message'))).toEqual([['dm.pin', 'm1', true]])
    expect(labels(onMessage(msg({ thread: 'root' }), chat))).toEqual([
      'Reply',
      'Forward',
      'Delete Message',
      'Copy Text',
      'Copy Timestamp',
      'Copy Message ID',
    ])
  })

  test('timed out: your own message can be deleted and its file downloaded, nothing written', async () => {
    chatState()
    const chat = facts({
      timedOut: true,
      mayPin: true,
      mayDelete: p => p.sender === ME,
      threads: true,
    })
    const own = onMessage(msg({ sender: ME, pinned: 5, att: [att('h1', 'a.txt')] }), chat)
    shownPeer().useP2p.setState({ files: { h1: file('none') } as never })
    expect(labels(own)).toEqual([
      'Forward',
      'Delete Message',
      'Download attachment',
      'Copy Text',
      'Copy Timestamp',
      'Copy Message ID',
    ])
    expect(row(own, 'Download attachment')?.disabled ?? false).toBe(false)
    expect(await run(row(own, 'Download attachment'))).toEqual([['files.download', 'h1']])
    expect(labels(onMessage(msg({ replies: 2 }), chat))).toEqual([
      'Forward',
      'View thread',
      'Copy Text',
      'Copy Timestamp',
      'Copy Message ID',
    ])
  })

  test('a message whose body is not here: pin, delete and the stamps only', () => {
    chatState()
    const chat = facts({ mayPin: true, mayDelete: () => true, threads: true })
    expect(labels(onMessage(msg({ unavailable: true, body: '' }), chat))).toEqual([
      'Pin Message',
      'Delete Message',
      'Copy Timestamp',
      'Copy Message ID',
    ])
    expect(labels(onMessage(msg({ body: '  ' })))).toEqual([
      'Reply',
      'Forward',
      'Copy Timestamp',
      'Copy Message ID',
    ])
  })

  test('one attachment is a row of its own; save, download or cancel', async () => {
    chatState()
    const one = onMessage(msg({ att: [att('h1', 'a.txt')] }))
    shownPeer().useP2p.setState({ files: { h1: file('done') } as never })
    const saveRow = row(one, 'Save attachment')!
    expect([saveRow.subtitle, saveRow.icon, saveRow.disabled ?? false]).toEqual([
      'a.txt',
      Download,
      false,
    ])
    expect(labels(one).indexOf('Save attachment')).toBe(2)
    expect(await run(saveRow)).toEqual([['files.save', 'h1']])
    shownPeer().useP2p.setState({ files: { h1: file('downloading') } as never })
    const cancel = row(one, 'Cancel download attachment')!
    expect(cancel.icon).toBe(X)
    expect(await run(cancel)).toEqual([['files.cancel', 'h1']])
    shownPeer().useP2p.setState({ files: { h1: file('none') } as never })
    expect(await run(row(one, 'Download attachment'))).toEqual([['files.download', 'h1']])
    shownPeer().useP2p.setState({ files: {} })
    expect(row(one, 'Download attachment')?.disabled).toBe(true)
    shownPeer().useP2p.setState({ files: { h1: file('none') } as never })
    const offline = onMessage(msg({ att: [att('h1', 'a.txt')] }), facts({ canAct: false }))
    expect(row(offline, 'Download attachment')?.disabled).toBe(true)
  })

  test('two or more attachments are a submenu, each with what it can do', async () => {
    chatState()
    const two = onMessage(msg({ att: [att('h1', 'a.txt'), att('h2', 'b.txt')] }))
    shownPeer().useP2p.setState({ files: { h1: file('downloading'), h2: file('none') } as never })
    const files = row(two, 'Attachments')!
    expect([files.icon, files.disabled ?? false]).toEqual([Download, false])
    expect(files.submenu?.map(i => [i.label, i.subtitle, i.icon, i.disabled ?? false])).toEqual([
      ['a.txt', 'Cancel download', X, false],
      ['b.txt', 'Download', Download, false],
    ])
    expect(await run(files.submenu![1])).toEqual([['files.download', 'h2']])
    shownPeer().useP2p.setState({ files: {} })
    const none = row(two, 'Attachments')!
    expect([none.icon, none.disabled ?? false]).toEqual([Download, false])
    expect(none.submenu?.map(i => [i.label, i.subtitle, i.icon, i.disabled ?? false])).toEqual([
      ['a.txt', 'Download', Download, true],
      ['b.txt', 'Download', Download, true],
    ])
    expect(await run(none.submenu![0])).toEqual([])
  })

  test('a pin line: jump, the pinned list and the stamps', async () => {
    chatState()
    const pin = msg({ system: { kind: 'pin', ik: BOB, target: 'm0' } })
    const t: Target = { kind: 'p2p_pin_line', p: pin, m: shown }
    expect(items(t).map(shape)).toEqual([
      ['Jump to Message', false, ArrowRight],
      ['Pinned Messages', false, Pin],
      ['Copy Timestamp', false, Clock],
      ['Copy Message ID', false, Hash],
    ])
    expect(await run(row(t, 'Jump to Message'))).toEqual([['dm.jumpTo', 'm0']])
    expect(await run(row(t, 'Pinned Messages'))).toEqual([['dm.openPins']])
    const gone: Target = { ...t, p: { ...pin, system: { kind: 'pin', ik: BOB, target: null } } }
    expect(labels(gone)).toEqual(['Pinned Messages', 'Copy Timestamp', 'Copy Message ID'])
  })
})

test("a contact's menu: mutual and pending", () => {
  const [me, bob, dave] = [0, 1, 2].map(() => keyId(newKeyPair().pk))
  chatState()
  shownPeer().useP2p.setState({
    contacts: [contact(bob, 'Bob'), contact(dave, 'Dave', 'outgoing')],
  })
  const menu = (c: Contact) => labels({ kind: 'p2p_contact', c, me })
  expect(menu(contact(bob, 'Bob'))).toEqual([
    'Message',
    'Mute DM',
    'Notification settings',
    'Rename',
    'Verify',
    'Encrypt stored messages',
    'Block',
    'Remove',
  ])
  expect(menu(contact(dave, 'Dave', 'outgoing'))).toEqual(['Rename', 'Verify', 'Block', 'Remove'])
})

test('the call route menu: direct (checked), then one row per relay of your own', async () => {
  chatState()
  useStore.setState({
    relayPrefs: {
      relays: [
        { url: 'turn:relay.example:3478', username: 'u', credential: 'c' },
        { url: 'stun:stun.example:3478' },
      ],
      allowed: [],
      ask: false,
      choice: 'auto',
    },
    iceHelpers: true,
    iceRelay: false,
  })
  const t: Target = { kind: 'p2p_call', peer: BOB, video: true }
  const list = items(t)
  expect(list.map(i => [i.label, i.subtitle, !!i.radio, !!i.checked, !!i.wrap])).toEqual([
    ['Direct (P2P)', P2P_IP_HINT, true, true, true],
    ['Direct through relay.example', undefined, false, false, true],
  ])
  expect(await run(list[0])).toEqual([['call.start', BOB, true]])
  expect(await run(list[1])).toEqual([['call.start', BOB, true, 'turn:relay.example:3478']])
})

test("an account badge's menu: copy the account, or check again when it couldn't", async () => {
  chatState()
  const ok: Target = { kind: 'p2p_badge', ik: BOB, sub: 'bob@host', stale: false }
  expect(items(ok).map(shape)).toEqual([['Copy account', false, Copy]])
  expect(await run(items(ok)[0])).toEqual([['copy', 'bob@host']])
  const stale: Target = { kind: 'p2p_badge', ik: BOB, sub: 'bob@host', stale: true }
  expect(items(stale).map(shape)).toEqual([['Check again', false, RefreshCw]])
  expect(await run(items(stale)[0])).toEqual([['badge.recheck', BOB]])
})

test("the P2P tile's menu lists the storage settings", () => {
  chatState()
  useStore.setState({ me: { username: 'ann' } as never, guest: false })
  shownPeer().useP2p.setState({ account: 'ann', enabled: true })
  expect(labels({ kind: 'p2p_home' })).toEqual(['P2P storage settings'])
})

test('P2P chat rows stay out of the palette', () => {
  chatState()
  const ids = new Set(paletteCommands(paletteCtx(useStore.getState())).map(r => r.id))
  const added = allActions()
    .map(a => a.id)
    .filter(id => /^p2p_(message|pin|call|badge)_/.test(id))
  expect(added.length).toBe(20)
  expect(added.filter(id => ids.has(id))).toEqual([])
})

describe('categories', () => {
  const CAT = { id: 'k1', name: 'Team', pos: 0, style: 'default' as const, over: {} }
  const onCategory = (v: ServerView): Target => ({ kind: 'p2p_category', v, cat: CAT })
  const IN = { ...TEXT, cat: 'k1', sync: false }

  test('only those who manage channels see the category and sync rows', async () => {
    state()
    const plain = server({ categories: [CAT] })
    expect(labels(onCategory(plain))).toEqual([])
    expect(labels(onChannel(plain, IN))).not.toContain('Sync Permissions')
    const v = server({ perms: P.ManageChannels, categories: [CAT] })
    expect(labels(onCategory(v))).toEqual([
      'Create Channel',
      'Create Separator',
      'Rename Category',
      'Category Style',
      'Permissions',
      'Delete Category',
    ])
    expect(labels(onChannel(v, IN)).filter(l => /Category|Sync/.test(l))).toEqual([
      'Move to Category',
      'Sync Permissions',
    ])
    expect(await run(row(onCategory(v), 'Permissions'))).toEqual([
      ['p2p.openDialog', { kind: 'perms', room: SRV, cat: 'k1' }],
    ])
    expect(labels(onChannel(v, { ...IN, sync: true }))).not.toContain('Sync Permissions')
    expect(labels(onChannel(v, { ...IN, cat: null }))).not.toContain('Sync Permissions')
    expect(labels(onChannel(server({ perms: P.ManageChannels }), IN))).not.toContain(
      'Move to Category'
    )
    expect(
      row(onChannel(v, IN), 'Move to Category')!.submenu!.map(i => [i.label, i.checked])
    ).toEqual([
      ['No category', false],
      ['Team', true],
    ])
  })

  test('moving, deleting and syncing, with a confirm when a sync lets more people in', async () => {
    state()
    const v = server({ perms: P.ManageChannels, categories: [CAT] })
    const none = row(onChannel(v, IN), 'Move to Category')!.submenu![0]
    expect(await run(none)).toEqual([['server.placeChannel', SRV, TEXT.id, null]])
    expect(await run(row(onCategory(v), 'Delete Category'))).toEqual([
      [
        'confirm',
        'Delete Category',
        'Delete the category Team? Its channels are kept and move out of it.',
        'Delete',
      ],
      ['server.deleteCategory', SRV, 'k1'],
    ])
    widens = []
    expect(await run(row(onChannel(v, IN), 'Sync Permissions'))).toEqual([
      ['server.syncWidens', SRV, TEXT.id],
      ['server.syncChannel', SRV, TEXT.id],
    ])
    widens = ['r:everyone', 'r:r1']
    expect(await run(row(onChannel(v, IN), 'Sync Permissions'))).toEqual([
      ['server.syncWidens', SRV, TEXT.id],
      [
        'confirm',
        'Sync Permissions',
        'Syncing with Team lets @everyone and Mods see or send in #general.',
        'Sync',
      ],
      ['server.syncChannel', SRV, TEXT.id],
    ])
    widens = []
  })
})

describe('separators', () => {
  const CAT = { id: 'k1', name: 'Team', pos: 0, style: 'dots' as const, over: {} }
  const SEP = { id: 'p1', label: 'News', style: 'dots' as const, cat: null, pos: 0.5 }
  const onSep = (v: ServerView, sep = SEP): Target => ({ kind: 'p2p_separator', v, sep })

  test('only those who manage channels get the separator rows; a row moves only where it can', () => {
    state()
    expect(labels(onSep(server({ separators: [SEP] })))).toEqual([])
    const v = server({ perms: P.ManageChannels, categories: [CAT], separators: [SEP] })
    expect(labels(onSep(v))).toEqual([
      'Edit Separator',
      'Move Up',
      'Move Down',
      'Move to Category',
      'Delete Separator',
    ])
    const last = { ...SEP, pos: 9 }
    expect(labels(onSep(server({ perms: P.ManageChannels, separators: [last] }), last))).toEqual([
      'Edit Separator',
      'Move Up',
      'Delete Separator',
    ])
    expect(labels({ kind: 'p2p_category', v, cat: CAT })).toContain('Create Separator')
    expect(
      row({ kind: 'p2p_category', v, cat: CAT }, 'Category Style')!.submenu!.map(i => [
        i.label,
        i.checked,
      ])
    ).toEqual([
      ['Plain caps', false],
      ['Dotted line', true],
      ['Solid line', false],
    ])
  })

  test('the rows open the form, move between neighbours, change the style and delete after a confirm', async () => {
    state()
    const v = server({ perms: P.ManageChannels, categories: [CAT], separators: [SEP] })
    expect(await run(row(onSep(v), 'Edit Separator'))).toEqual([
      ['p2p.openDialog', { kind: 'separator', room: SRV, id: 'p1' }],
    ])
    expect(await run(row({ kind: 'p2p_category', v, cat: CAT }, 'Create Separator'))).toEqual([
      ['p2p.openDialog', { kind: 'separator', room: SRV, cat: 'k1' }],
    ])
    expect(await run(row(onSep(v), 'Move Up'))).toEqual([
      ['server.editSeparator', SRV, 'p1', { pos: -1 }],
    ])
    expect(await run(row(onSep(v), 'Move Down'))).toEqual([
      ['server.editSeparator', SRV, 'p1', { pos: 2 }],
    ])
    const team = row(onSep(v), 'Move to Category')!.submenu!.find(i => i.label === 'Team')
    expect(await run(team)).toEqual([['server.editSeparator', SRV, 'p1', { cat: 'k1' }]])
    const line = row({ kind: 'p2p_category', v, cat: CAT }, 'Category Style')!.submenu![2]
    expect(await run(line)).toEqual([['server.editCategory', SRV, 'k1', { style: 'line' }]])
    expect(await run(row(onSep(v), 'Delete Separator'))).toEqual([
      [
        'confirm',
        'Delete Separator',
        'Delete the separator News? The channels around it stay.',
        'Delete',
      ],
      ['server.deleteSeparator', SRV, 'p1'],
    ])
  })
})
