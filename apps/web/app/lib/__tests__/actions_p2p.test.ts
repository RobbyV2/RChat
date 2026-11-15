import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Bell, BellOff, CheckCheck, Crown, LogOut, Settings, UserPlus, Volume2 } from 'lucide-react'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems, openActionMenu, openChoiceMenu } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { memberMenu } from '../../components/p2p/p2p_server_view'
import { roleItems, roleMenuItems } from '../../components/p2p/p2p_server_roles'
import { allActions } from '../actions/registry'
import type { Target } from '../actions/types'
import { emptyLayout, type Folder } from '../nav_layout'
import { EMPTY_NOTIFY, MUTE_CHOICES, setMute, type NotifyPrefs } from '../notify'
import { p2p, p2pDm, p2pRail, p2pServer, p2pVoice, useP2p } from '../p2p/app'
import type { Contact } from '../p2p/contacts'
import type { MemberView, RoleView, ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { setSharing, sharing } from '../platform'
import { resetSessionCaches, useStore, type ConfirmRequest, type ContextMenuItem } from '../store'

const initial = useStore.getState()
const p2pInitial = useP2p.getState()
const realSharing = sharing()

beforeAll(registerAppActions)

afterEach(() => {
  setSharing(realSharing)
  useStore.setState(initial, true)
  useP2p.setState(p2pInitial, true)
})

afterAll(resetSessionCaches)

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
  over: {},
}
const VOICE = {
  id: 'v1',
  name: 'Lounge',
  kind: 'voice',
  pos: 1,
  send: true,
  exempt: false,
  over: {},
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
    roles: ROLES,
    channels: [TEXT, VOICE],
    members: Object.values(MEMBERS),
    chans: {},
    voice: {},
    upgraded: false,
    ...over,
  }) as ServerView

const MOD = P.Kick | P.Ban | P.ManageRoles | P.ManageMessages

const state = (o: { notify?: NotifyPrefs; streamer?: boolean } = {}) => {
  useStore.setState({ notifyPrefs: o.notify ?? EMPTY_NOTIFY, streamer: !!o.streamer })
  useP2p.setState({
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
const onMember = (v: ServerView, m: MemberView): Target => ({ kind: 'p2p_member', v, m })
const onRole = (v: ServerView, r: RoleView): Target => ({ kind: 'p2p_role', v, r })

const settle = () => new Promise(r => setTimeout(r, 0))

// What the rows did: confirms (accepted with their first choice), copies and P2P calls.
const recorder = () => {
  const calls: unknown[][] = []
  useStore.setState({
    askConfirm: (c: ConfirmRequest) => {
      calls.push(['confirm', c.title, c.body, c.confirm])
      c.action(c.choices?.[0]?.value ?? '')
    },
    muteScope: (scope, until) => void calls.push(['mute', scope, until === null ? null : 'later']),
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
        calls.push([`${name}.${String(k)}`, ...args])
        return Promise.resolve(null)
      }
  }
  const saved = {
    server: { ...p2pServer },
    rail: { ...p2pRail },
    voice: { ...p2pVoice },
    p2p: { ...p2p },
    dm: { ...p2pDm },
  }
  spy('server', p2pServer, [
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
    'deleteRole',
  ])
  spy('rail', p2pRail, ['move', 'ungroup'])
  spy('voice', p2pVoice, ['join', 'leave'])
  spy('p2p', p2p, ['openDialog', 'openHome'])
  spy('dm', p2pDm, ['openDm'])
  const restore = () => {
    Object.assign(p2pServer, saved.server)
    Object.assign(p2pRail, saved.rail)
    Object.assign(p2pVoice, saved.voice)
    Object.assign(p2p, saved.p2p)
    Object.assign(p2pDm, saved.dm)
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

  test('invited: leave; no longer a member: remove from this device', async () => {
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
    useP2p.setState({ layout: { ...emptyLayout, servers: [folder] } })
    const t: Target = { kind: 'folder', folder, p2p: true }
    expect(labels(t)).toEqual(['Folder color', 'Edit folder', 'Ungroup'])
    expect(await run(row(t, 'Edit folder'))).toEqual([
      ['p2p.openDialog', { kind: 'p2p_folder', id: 'p1' }],
    ])
    expect(await run(row(t, 'Ungroup'))).toEqual([['rail.ungroup', 'p1']])
    useP2p.setState({ layout: emptyLayout })
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
      'Delete Channel',
      'Copy Channel ID',
    ])
    expect(row(t, 'Delete Channel')?.danger).toBe(true)
    expect(await run(row(t, 'Edit Channel'))).toEqual([
      ['p2p.openDialog', { kind: 'server_settings', room: SRV, tab: 'channels' }],
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
    expect(labels(t)).toEqual(['Join Voice', 'Edit Channel', 'Delete Channel', 'Copy Channel ID'])
    expect(row(t, 'Join Voice')?.icon).toBe(Volume2)
    expect(await run(row(t, 'Join Voice'))).toEqual([
      ['server.openChannel', 'v1'],
      ['voice.join', SRV, 'v1'],
    ])
    expect((await run(row(t, 'Delete Channel')))[0]).toEqual([
      'confirm',
      'Delete Channel',
      'Delete Lounge?',
      'Delete',
    ])
    useP2p.setState({ voice: { room: SRV, ch: 'v1' } as never })
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
    expect(labels(onMember(v, MEMBERS.me))).toEqual(['Copy Identity Key'])
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

  test('as a moderator owner: roles, kick, transfer and ban; transfer is danger now', () => {
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
      ['confirm', 'Ban Member', "Ban this member? They can't come back.", 'Ban'],
      ['server.ban', SRV, CAROL, false],
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
    expect(labels(onRole(v, mods))).toEqual(['Move Down', 'Delete Role'])
    expect(labels(onRole(v, helpers))).toEqual(['Move Up', 'Move Down'])
    expect(labels(onRole(v, fans))).toEqual(['Move Up', 'Delete Role'])
    expect(labels(onRole(server({ perms: P.ManageRoles | P.ManageChannels }), helpers))).toEqual([
      'Move Up',
      'Move Down',
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

test('P2P server, channel, member and role rows stay out of the palette (rule 10)', () => {
  state()
  useP2p.setState({ servers: { [SRV]: server({ perms: 0x7fffffff, owner: ME, owners: [ME] }) } })
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
