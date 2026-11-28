import { flush } from './helpers/test_clock'
import { beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SystemMessagesSection } from '../../components/system_messages'
import { ctxFor } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import type { Target } from '../actions/types'
import { AccountProvider } from '../client/react'
import type { ChannelView, ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { featureAt, isUnsupported } from '../place/feature'
import {
  systemMessages,
  systemMessagesOf,
  type SystemPlace,
  type SystemSettings,
} from '../place/system_messages'
import type { RChatState } from '../store_types'
import { SYSTEM_HERE_DONE, SYSTEM_HERE_TITLE } from '../system_messages'
import { Perm, type Channel, type ServerSummary, type SystemMessages } from '../types'
import { member, paged, role, serverDetail } from './fixtures'
import { placeContract, type ContractWorld, type Seat } from './helpers/place_contract'

beforeAll(registerAppActions)

type Call = unknown[]

// How a party stands in the place: its owner, a member whose role carries the named
// permissions, or (hosted only) a hidden site admin.
type Standing = 'owner' | 'site_admin' | { role: bigint }

const GENERAL: Channel = {
  id: 1,
  name: 'general',
  kind: 'text',
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
}
const RANDOM: Channel = {
  id: 2,
  name: 'random',
  kind: 'text',
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
}
const LOUNGE: Channel = {
  id: 3,
  name: 'lounge',
  kind: 'voice',
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
}

const peerChannel = (id: string, name: string, kind: string) =>
  ({ id, name, kind, pos: 0, perms: 0n }) as unknown as ChannelView

const SAVED: SystemMessages = { channel_id: null, join_messages: true, leave_messages: true }

// Seats a party in a place with #general, #random and a voice channel, and records what the
// side is asked to save. `joined`: a P2P identity that left keeps its view of the room.
const seat = (
  world: ContractWorld,
  who: Seat,
  standing: Standing,
  calls: Call[] = [],
  joined = true
) => {
  const place = who.place as SystemPlace
  if (place.kind === 'hostedServer') {
    const me = who.account.store.getState().me!
    const perms = typeof standing === 'object' ? standing.role : 0n
    const state = {
      me: {
        ...me,
        is_site_admin: standing === 'site_admin',
        servers: [{ name: world.server, is_admin: standing === 'owner' } as ServerSummary],
      },
      servers: {
        [world.server]: serverDetail(world.server, {
          channels: [GENERAL, RANDOM, LOUNGE],
          roles: [role(1, '#f00', perms)],
        }),
      },
      members: {
        [world.server]: paged([
          member(me.username, { role_ids: [1], is_admin: standing === 'owner' }),
        ]),
      },
    } as Partial<RChatState>
    who.account.store.setState(state)
    Object.assign(who.account.store.getInitialState(), state)
    let saved = SAVED
    Object.assign(who.account.api, {
      systemMessages: async () => saved,
      updateSystemMessages: async (server: string, patch: Partial<SystemMessages>) => {
        calls.push([server, patch])
        saved = { ...saved, ...patch }
        return saved
      },
    })
    return place
  }
  const view = {
    id: world.room,
    me: joined ? 'join' : 'leave',
    owner: standing === 'owner' ? who.name : 'Z',
    owners: [standing === 'owner' ? who.name : 'Z'],
    perms: standing === 'owner' ? ~0 : typeof standing === 'object' ? Number(standing.role) : 0,
    members: [],
    chans: {},
    voice: {},
    categories: [],
    roles: [],
    rank: [Infinity, ''],
    system: { ch: 'c1', join: true, leave: true },
    systemPick: null,
    channels: [
      peerChannel('c1', 'general', 'text'),
      peerChannel('c2', 'random', 'text'),
      peerChannel('c3', 'lounge', 'voice'),
    ],
  } as unknown as ServerView
  const state = { servers: { [world.room]: view } }
  place.app.useP2p.setState(state)
  Object.assign(place.app.useP2p.getInitialState(), state)
  Object.assign(place.app.p2pServer, {
    setSystem: async (room: string, sys: ServerView['system']) => {
      calls.push([room, sys])
      place.app.useP2p.setState({
        servers: { [world.room]: { ...view, system: sys, systemPick: sys.ch } },
      })
      return null
    },
  })
  return place
}

const settle = () => flush()

const ready = async (place: SystemPlace) => {
  const at = systemMessagesOf(place)
  at.load()
  await settle()
  const shown = at.settings.get()
  if (shown.state !== 'ready') throw new Error(`settings are ${shown.state}`)
  return shown
}

placeContract(systemMessages, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no join and leave messages', () => {
      const here = featureAt(systemMessages, world().ann.place)
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const hosted = kind === 'hostedServer'
  const manage = hosted ? Perm.ManageServer : BigInt(P.ManageServer)
  const others = hosted
    ? Perm.ManageChannels | Perm.ManageRoles | Perm.Kick | Perm.ManageInvites
    : BigInt(P.ManageChannels | P.ManageRoles | P.Kick | P.Ban | P.ManageMessages)
  const where = () => (hosted ? world().server : world().room)
  // The keys of #random, #general and the voice channel.
  const [random, general, lounge] = hosted ? ['2', '1', '3'] : ['c2', 'c1', 'c3']
  const sent = (patch: Partial<SystemSettings>): Call =>
    hosted
      ? [
          where(),
          {
            ...(patch.channel === undefined ? {} : { channel_id: Number(patch.channel) || null }),
            ...(patch.join === undefined ? {} : { join_messages: patch.join }),
            ...(patch.leave === undefined ? {} : { leave_messages: patch.leave }),
          },
        ]
      : [where(), { ch: patch.channel || null, join: patch.join ?? true, leave: true }]

  const holders: [string, Standing][] = [
    ['the owner', 'owner'],
    ['a member whose role has Manage Server', { role: manage }],
    ['a member whose role has it among others', { role: manage | others }],
    ...(hosted ? ([['a site admin', 'site_admin']] as [string, Standing][]) : []),
  ]
  for (const [name, standing] of holders)
    test(`${name} changes the channel`, async () => {
      const calls: Call[] = []
      const place = seat(world(), world().ann, standing, calls)
      const before = await ready(place)
      expect(before.settings).toEqual({ channel: '', join: true, leave: true })
      expect(before.choices.map(c => c.label)).toEqual(['Default channel', '#general', '#random'])
      const editor = systemMessagesOf(place).editor.get()
      expect(editor).not.toBeNull()
      await editor!.save({ channel: random })
      expect(calls).toEqual([sent({ channel: random })])
      expect((await ready(place)).settings.channel).toBe(random)
    })

  test('whoever lacks Manage Server holds no way to change them', () => {
    const { ann, bob } = world()
    const plain = seat(world(), ann, { role: 0n })
    expect(systemMessagesOf(plain).editor.get()).toBeNull()
    const other = seat(world(), bob, { role: others })
    expect(systemMessagesOf(other).editor.get()).toBeNull()
    if (hosted) {
      ann.account.store.setState({ me: null })
      expect(systemMessagesOf(plain).editor.get()).toBeNull()
    } else {
      const left = seat(world(), ann, { role: manage }, [], false)
      expect(systemMessagesOf(left).editor.get()).toBeNull()
    }
  })

  test('the right to change them comes and goes with the permission', () => {
    const { ann } = world()
    const place = seat(world(), ann, { role: 0n })
    const { editor } = systemMessagesOf(place)
    let changes = 0
    const off = editor.subscribe(() => (changes += 1))
    expect(editor.get()).toBeNull()
    seat(world(), ann, { role: manage })
    expect(changes).toBeGreaterThan(0)
    expect(editor.get()).not.toBeNull()
    expect(editor.get()).toBe(editor.get())
    seat(world(), ann, { role: others })
    expect(editor.get()).toBeNull()
    off()
  })

  test('each kind of line turns off on its own, and the default channel comes back', async () => {
    const calls: Call[] = []
    const place = seat(world(), world().ann, 'owner', calls)
    await ready(place)
    const editor = systemMessagesOf(place).editor.get()!
    await editor.save({ join: false })
    expect((await ready(place)).settings).toEqual({ channel: '', join: false, leave: true })
    await editor.save({ channel: general })
    await editor.save({ channel: '' })
    expect((await ready(place)).settings.channel).toBe('')
    expect(calls.map(c => c[0])).toEqual([where(), where(), where()])
  })

  test('the section reads the same on both sides', async () => {
    const { ann } = world()
    const place = seat(world(), ann, 'owner')
    await ready(place)
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <SystemMessagesSection place={place} />
      </AccountProvider>
    )
    for (const text of [
      'Channel for join and leave messages',
      'Default channel',
      '#general',
      '#random',
      'The default channel is the first text channel.',
      'Show a message when someone joins',
      'Show a message when someone leaves',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('lounge')
    expect(html).not.toContain('disabled=""')
    expect(html.includes('device writes these lines itself')).toBe(!hosted)
  })

  test('whoever may not change them reads the section with its controls off', async () => {
    const { ann } = world()
    const place = seat(world(), ann, { role: others })
    await ready(place)
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <SystemMessagesSection place={place} />
      </AccountProvider>
    )
    expect(html.match(/disabled=""/g)).toHaveLength(3)
  })

  // The menu of a channel as the place's sidebar opens it.
  const menuOf = (who: Seat, channel: string) => {
    const place = who.place as SystemPlace
    const target: Target =
      place.kind === 'hostedServer'
        ? {
            kind: 'channel',
            server: place.server,
            channel: [GENERAL, RANDOM, LOUNGE].find(c => String(c.id) === channel)!,
          }
        : (() => {
            const v = place.app.useP2p.getState().servers[place.room]!
            return { kind: 'p2p_channel', v, ch: v.channels.find(c => c.id === channel)! }
          })()
    return menuItems(ctxFor(who.account.store.getState(), target, 'menu', who.account, who.app))
  }
  const here = (who: Seat, channel: string) =>
    menuOf(who, channel).find(i => i.label === SYSTEM_HERE_TITLE)

  test('a text channel offers the lines to whoever holds Manage Server, and to nobody else', () => {
    const { ann, bob } = world()
    for (const [, standing] of holders) {
      seat(world(), ann, standing)
      expect(here(ann, random)?.label).toBe(SYSTEM_HERE_TITLE)
      expect(here(ann, lounge)).toBeUndefined()
    }
    seat(world(), bob, { role: others })
    expect(here(bob, random)).toBeUndefined()
    seat(world(), bob, { role: 0n })
    expect(here(bob, random)).toBeUndefined()
  })

  test('the channel action moves the lines there and says so', async () => {
    const calls: Call[] = []
    const { ann } = world()
    const place = seat(world(), ann, { role: manage }, calls)
    await ready(place)
    here(ann, random)!.action?.()
    await settle()
    expect(calls).toEqual([sent({ channel: random })])
    expect(ann.account.store.getState().toast?.text).toBe(SYSTEM_HERE_DONE)
    expect((await ready(place)).settings.channel).toBe(random)
  })

  test('a refused change is told, and the settings stay', async () => {
    const { ann } = world()
    const place = seat(world(), ann, { role: manage })
    await ready(place)
    const refuse = async () => {
      throw new Error('Not allowed')
    }
    if (place.kind === 'hostedServer')
      Object.assign(ann.account.api, { updateSystemMessages: refuse })
    else Object.assign(place.app.p2pServer, { setSystem: refuse })
    here(ann, random)!.action?.()
    await settle()
    expect(ann.account.store.getState().error).toBe('Not allowed')
    expect((await ready(place)).settings.channel).toBe('')
  })
})
