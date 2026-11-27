import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BanDialog } from '../../components/ban_dialog'
import { TimeoutDialog } from '../../components/timeout_dialog'
import { AccountProvider } from '../client/react'
import { PURGE_ALL } from '../durations'
import { P } from '../p2p/state'
import type { ServerView } from '../p2p/server'
import { featureAt, isUnsupported } from '../place/feature'
import {
  askKick,
  moderation,
  moderationOf,
  openBan,
  openTimeout,
  type ModerationPlace,
} from '../place/moderation'
import type { RChatState } from '../store_types'
import { member, paged } from './fixtures'
import {
  contractWorld,
  disposeWorld,
  placeContract,
  type ContractWorld,
  type Seat,
} from './helpers/place_contract'

type Call = unknown[]

// Ann moderates Bob: the place lists him, with `until` as the end of his timeout, and what the
// side sends is recorded.
const seated = (world: ContractWorld, calls: Call[], until?: number) => {
  const { ann } = world
  const place = ann.place as ModerationPlace
  if (place.kind === 'hostedServer') {
    const sent =
      (name: string, answer: unknown) =>
      async (...a: unknown[]) => {
        calls.push([name, ...a])
        return answer
      }
    ann.account.store.setState({
      dms: [],
      members: { [world.server]: paged([member('ann'), member('bob', { display_name: 'Bob' })]) },
      timeouts:
        until === undefined ? {} : { [world.server]: { bob: { ends: until, reason: 'spam' } } },
      kickMember: sent('kick', undefined),
      banMember: sent('ban', true),
      timeoutMember: sent('timeout', true),
      removeTimeout: sent('untimeout', undefined),
    } as Partial<RChatState>)
    Object.assign(ann.account.store.getInitialState(), ann.account.store.getState())
    return place
  }
  const view = {
    id: world.room,
    perms: P.Ban | P.ManageMessages,
    timedBans: true,
    members: [
      { ik: 'A', name: 'Ann', m: 'join' },
      {
        ik: 'B',
        name: 'Bob',
        m: 'join',
        ...(until === undefined ? {} : { timeoutUntil: until, timeoutReason: 'spam' }),
      },
    ],
  } as unknown as ServerView
  const state = { servers: { [world.room]: view } }
  place.app.useP2p.setState(state)
  Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
  const sent =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a])
      return null
    }
  Object.assign(place.app.p2pServer, {
    kick: sent('kick'),
    ban: sent('ban'),
    timeout: sent('timeout'),
    untimeout: sent('untimeout'),
  })
  return place
}

const settle = () => new Promise(r => setTimeout(r, 0))

placeContract(moderation, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no moderation', () => {
      const here = featureAt(moderation, world().ann.place)
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const hosted = kind === 'hostedServer'
  const key = (seat: Seat) => (hosted ? seat.account.store.getState().me!.username : seat.name)
  const where = () => (hosted ? world().server : world().room)

  test('a member is named as the place shows them, with the timeout set for them', () => {
    const place = seated(world(), [], 5_000)
    const shown = moderationOf(place).member(key(world().bob))
    expect(shown.get().name).toBe('Bob')
    expect(shown.get().user?.username).toBe(hosted ? 'bob' : undefined)
    expect(shown.get().timeout).toEqual({ ends: 5_000, reason: 'spam' })
    expect(shown.get()).toBe(shown.get())
    expect(moderationOf(seated(world(), [])).member(key(world().bob)).get().timeout).toBeNull()
  })

  test('a kick is confirmed first, then sent to the side of the place', async () => {
    const calls: Call[] = []
    const place = seated(world(), calls)
    let after = 0
    askKick(place, key(world().bob), () => (after += 1))
    const confirm = world().ann.account.store.getState().confirm
    expect(confirm?.title).toBe('Kick Member')
    expect(confirm?.confirm).toBe('Kick')
    expect(confirm?.body).toBe(
      hosted
        ? 'Kick this member? They are removed from the server but can join again.'
        : 'Kick Bob? They can come back with a new invite.'
    )
    expect(confirm?.reason).toBe(true)
    expect(calls).toEqual([])
    confirm?.action('', 'spam')
    await settle()
    expect(calls).toEqual([['kick', where(), key(world().bob), 'spam']])
    expect(after).toBe(1)
  })

  test('a ban carries what the side supports', async () => {
    const calls: Call[] = []
    const place = seated(world(), calls)
    const { ban } = moderationOf(place)
    expect(ban.support.get()).toEqual({ timed: true, purge: 'window' })
    expect(ban.title).toBe(hosted ? 'Ban from Server' : 'Ban Member')
    const choice = { seconds: 3600, reason: 'spam', purgeHours: 24 }
    expect(await ban.run(key(world().bob), choice)).toBe(true)
    await settle()
    expect(calls).toEqual([
      hosted
        ? ['ban', where(), 'bob', choice]
        : ['ban', where(), 'B', { wipe: true, reason: 'spam', seconds: 3600, purgeH: 24 }],
    ])
  })

  test('a timeout is set and removed on the side of the place', async () => {
    const calls: Call[] = []
    const place = seated(world(), calls)
    const { timeout, untimeout } = moderationOf(place)
    const who = key(world().bob)
    expect(await timeout(who, { seconds: 600, reason: 'spam' })).toBe(true)
    expect(await timeout(who, { seconds: 60, reason: null })).toBe(true)
    untimeout(who)
    await settle()
    expect(calls).toEqual([
      ['timeout', where(), who, 600, 'spam'],
      ['timeout', where(), who, 60, hosted ? '' : undefined],
      ['untimeout', where(), who],
    ])
  })

  test('the dialogs open on the member of the place', () => {
    const place = seated(world(), [])
    const who = key(world().bob)
    const dialog = () => world().ann.account.store.getState().activeDialog
    openBan(place, who)
    expect(dialog()).toEqual({ kind: 'ban', place, who })
    openTimeout(place, who)
    expect(dialog()).toEqual({ kind: 'timeout', place, who })
  })

  test('the dialogs show the member, the running timeout and what a ban supports', () => {
    const place = seated(world(), [], Date.now() + 3_600_000)
    const who = key(world().bob)
    const render = (node: React.ReactElement) =>
      renderToStaticMarkup(<AccountProvider session={world().ann.account}>{node}</AccountProvider>)
    const timeout = render(<TimeoutDialog place={place} who={who} onClose={() => {}} />)
    expect(timeout).toContain('Change timeout')
    expect(timeout).toContain('data-timeout-current')
    expect(timeout).toContain('Reason: spam')
    expect(timeout).toContain('Remove timeout')
    expect(timeout).toContain('value="spam"')
    expect(timeout).toContain('>Bob')
    expect(timeout.includes('@bob')).toBe(hosted)
    const ban = render(<BanDialog place={place} who={who} onClose={() => {}} />)
    expect(ban).toContain(hosted ? 'Ban from Server' : 'Ban Member')
    expect(ban).toContain('Duration')
    expect(ban).toContain('>Bob')
  })

  test('a timeout that ended shows as none', () => {
    const place = seated(world(), [], Date.now() - 1)
    const html = renderToStaticMarkup(
      <AccountProvider session={world().ann.account}>
        <TimeoutDialog place={place} who={key(world().bob)} onClose={() => {}} />
      </AccountProvider>
    )
    expect(html).toContain('Time out member')
    expect(html).toContain('10 minutes')
    expect(html).not.toContain('data-timeout-current')
    expect(html).not.toContain('Remove timeout')
  })
})

test('a P2P ban offers what the room rules and your permissions allow', () => {
  const world = contractWorld('p2pRoom')
  try {
    const place = world.ann.place as ModerationPlace & { kind: 'p2pRoom' }
    const support = (view: Partial<ServerView>) => {
      place.app.useP2p.setState({
        servers: { [world.room]: { id: world.room, members: [], ...view } as ServerView },
      })
      return moderationOf(place).ban.support.get()
    }
    expect(support({ perms: P.Ban })).toEqual({ timed: false, purge: 'none' })
    expect(support({ perms: P.Ban | P.ManageMessages })).toEqual({ timed: false, purge: 'all' })
    expect(support({ perms: P.Ban | P.ManageMessages, timedBans: true })).toEqual({
      timed: true,
      purge: 'window',
    })
    const calls: unknown[][] = []
    place.app.p2pServer.ban = async (...a) => {
      calls.push(a)
      return null
    }
    support({ perms: P.Ban | P.ManageMessages })
    moderationOf(place).ban.run('B', { seconds: 3600, reason: null, purgeHours: PURGE_ALL })
    expect(calls).toEqual([[world.room, 'B', { wipe: true }]])
  } finally {
    disposeWorld(world)
  }
})
