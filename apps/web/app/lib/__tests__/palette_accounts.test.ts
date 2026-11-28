import { expect, test } from 'bun:test'
import { client } from '../client/client'
import { accountPaletteSections } from '../client/palette_accounts'
import { accountStorage } from '../client/keys'
import { flatItems, type ResultCtx } from '../palette_results'
import { PaletteIndex } from '../palette_index'
import { messageDoc } from '../palette_sync'
import { p2pBucket, p2pSourceId } from '../p2p/palette_source'
import { channelTarget } from '../viewing'
import { registerAppActions } from '../actions'
import { testAccount } from './test_account'
import { me, member, memoryStorage, msg, serverDetail, summary, textChannel } from './fixtures'
import { Secret } from '../secret'

const ctx: ResultCtx = {
  usage: {},
  now: 1,
  index: null,
  visible: () => true,
  ops: null,
  history: [],
  recents: [],
  mask: t => t.replaceAll('Unmasked', 'Filtered'),
}
test('a palette keeps identical destinations under their owners, rechecks consent and membership, and runs commands as its actor', async () => {
  const previous = client.shown(),
    book = client.book.getState()
  const a = testAccount('sam', 'https://a-palette.example'),
    b = testAccount('sam', 'https://b-palette.example')
  const owners = [a, b]
  const token = (account: typeof a) => accountStorage(account.conn).token('sam')
  const picked: string[] = []
  const channel = { ...textChannel(4), name: 'general' }
  const roles = {
    ...me('sam'),
    servers: [summary('club', { display_name: 'Club' })],
  }
  registerAppActions()
  try {
    client.book.setState(
      {
        v: 1,
        instances: owners.map((account, i) => ({
          origin: account.conn.origin,
          id: String(i),
          name: 'Shared instance',
          accounts: [
            {
              username: 'sam',
              display: 'Sam',
              avatar: null,
              connect: true,
              identities: [
                { local: 'field', name: 'Field', ik: null, background: false, added: 1 },
              ],
              added: 1,
            },
          ],
          guest: false,
        })),
      },
      true
    )
    for (const account of owners) {
      memoryStorage.setItem(token(account), 'fixture-' + account.renderKey)
      account.store.setState({
        token: Secret.of('fixture-' + account.renderKey),
        me: roles,
        servers: { club: serverDetail('club', { channels: [channel] }) },
        openChannel: async () => {
          picked.push(account === client.shown() ? 'shown' : 'wrong')
        },
        openFriends: () => picked.push(account === a ? 'actor' : 'other'),
      })
    }
    client.show(a, 'none')
    const groups = accountPaletteSections(a, '#general', ctx)
    expect(groups.map(s => s.owner?.account.renderKey)).toEqual([a.renderKey, b.renderKey])
    expect(flatItems(groups).map(i => i.id)).toEqual(['channel_4', 'channel_4'])
    const switches = flatItems(accountPaletteSections(a, '>Switch to', ctx)).filter(
      i => i.action === 'switch_to_actor'
    )
    for (const owner of owners) {
      expect(
        switches
          .filter(i => i.title.endsWith(' on ' + owner.conn.host))
          .map(i => i.subtitle)
          .sort()
      ).toEqual(['P2P · sam', 'sam'])
      expect(switches.some(i => i.title === 'Switch to Field on ' + owner.conn.host)).toBe(true)
    }
    const foreign = groups[1].items[0].item
    const protectedChannel = channelTarget('sam', 'instance', 'club', channel, b.conn)
    b.viewing.markPersonally(protectedChannel, true)
    expect(foreign.available?.()).toBe(false)
    await foreign.run()
    expect(picked).toEqual([])
    expect(client.shown()).toBe(a)
    b.viewing.markPersonally(protectedChannel, false)
    await foreign.run()
    expect(picked).toEqual(['shown'])
    expect(client.shown()).toBe(b)
    const commands = flatItems(accountPaletteSections(a, '>Open friends', ctx)).filter(
      i => i.id === 'friends'
    )
    expect(commands.length).toBe(1)
    await commands[0].run()
    expect(picked).toEqual(['shown', 'actor'])
    await groups[0].items[0].item.run()
    expect(client.shown()).toBe(a)
    expect(picked.at(-1)).toBe('shown')
    const root = msg(13, { channel_id: 4, content: 'garden notebook', reply_count: 1 })
    const roots = () => flatItems(accountPaletteSections(a, '#notebook', ctx))
    const blocked = { [root.author.username]: true as const }
    b.store.setState({ messages: { c4: [root] }, blocked })
    expect(roots()).toEqual([])
    b.store.setState({ blocked: {} })
    const thread = roots()[0]
    expect(thread.id).toBe('thread_13')
    b.store.setState({ blocked })
    expect(thread.available?.()).toBe(false)
    await thread.run()
    expect(client.shown()).toBe(a)
    b.store.setState({
      blocked: {},
      openChannel: async () => b.store.setState({ blocked }),
      openThread: async () => {
        throw Error('opened a thread after its author was blocked')
      },
    })
    await thread.run()
    expect(client.shown()).toBe(b)
    b.store.setState({ blocked: {} })
    const ix = new PaletteIndex(200000)
    const doc = messageDoc(
      b.store.getState(),
      'c4',
      msg(6, { channel_id: 4, content: 'Unmasked secret' }),
      'club'
    )!
    ix.add([doc])
    b.indexer.paletteIndex = () => ix
    const results = (text: string) =>
      accountPaletteSections(a, text, ctx)
        .filter(s => s.owner?.account === b)
        .flatMap(s => s.items.map(x => x.item))
    const message = results('secret').find(i => i.id === 'message_m6')!
    expect(message.title).toBe('Filtered secret')
    b.viewing.markPersonally(protectedChannel, true)
    expect(message.available?.()).toBe(false)
    const user = member('dana')
    b.store.setState({ members: { club: { q: '', loading: false, hasMore: false, list: [user] } } })
    const person = results('@dana').find(i => i.id === 'person_dana')!
    b.store.setState({ memberInfo: { club: { dana: null } } })
    expect(person.available?.()).toBe(false)
    b.store.setState({ memberInfo: {}, me: me('sam') })
    expect(results('@dana')).toEqual([])
    b.store.setState({ me: roles })
    memoryStorage.removeItem(token(b))
    expect(foreign.available?.()).toBe(false)
    expect(results('#general')).toEqual([])
  } finally {
    client.show(previous, 'none')
    client.book.setState(book, true)
    for (const account of owners) {
      memoryStorage.removeItem(token(account))
      account.store.dispose()
    }
  }
})

test('identical peer contacts stay under each identity, the acting peer is first, and an old key cannot select a replacement', async () => {
  const actor = testAccount('sam', 'https://peer-palette.example')
  const prev = client.shown()
  try {
    client.show(actor, 'none')
    actor.store.setState({ settings: { ...actor.store.getState().settings, p2p: true } })
    actor.identities.setAccount('sam')
    const main = actor.identities.get()!,
      work = actor.identities.add('work')
    const contact = {
      ik: 'dana-key',
      name: 'Dana',
      petname: null,
      profile: null,
      certs: [],
      revocations: [],
      state: 'mutual' as const,
      ignored: false,
      intros: [],
      verified: false,
      verifiedAt: null,
      warning: null,
      notice: null,
      host: 'local',
      added: 0,
      lastSeen: null,
    }
    for (const app of [main, work])
      app.useP2p.setState({
        enabled: true,
        account: 'sam',
        ik: app.localId + '-key',
        name: app.localId,
        contacts: [contact],
        home: true,
      })
    const index = new PaletteIndex(200000)
    for (const app of [main, work]) {
      const room = {
        id: 'room',
        peer: contact.ik,
        seq: 1,
        unread: 0,
        pings: 0,
        lastTs: 1,
        count: 1,
        bytes: 4,
        full: false,
        fullWhy: undefined,
        peerFull: false,
        gap: false,
      }
      app.useP2p.setState({ rooms: { room } })
      index.add([
        {
          id: app.localId === 'main' ? 'pnote' : p2pSourceId(app) + ':note',
          kind: 'message',
          bucket: p2pBucket('room', null, app),
          source: p2pSourceId(app),
          server: null,
          channel: null,
          dm: null,
          thread: null,
          msg: null,
          author: contact.ik,
          name: 'Dana',
          text: app.localId + ' indexed memo',
          at: 1,
        },
      ])
    }
    actor.indexer.paletteIndex = () => index
    actor.identities.show(work)
    const messages = accountPaletteSections(actor, 'memo', ctx).filter(s => s.group === 'messages')
    expect(messages.map(s => [s.owner?.local, s.items[0].item.title])).toEqual([
      ['work', 'work indexed memo'],
      ['main', 'main indexed memo'],
    ])
    const find = () => accountPaletteSections(actor, '@Dana', ctx)
    const groups = find()
    expect(groups.map(s => s.owner?.local)).toEqual(['work', 'main'])
    const target = groups[1].items[0].item
    let opened = ''
    main.p2pDm.openDm = async key => {
      opened = actor.identities.viewed()?.localId + '/' + key
    }
    await target.run()
    expect(opened).toBe('main/dana-key')
    main.useP2p.setState({ ik: 'new-main-key' })
    expect(target.available?.()).toBe(false)
    main.useP2p.setState({ contacts: [{ ...contact, state: 'blocked' }] })
    expect(find().map(s => s.owner?.local)).toEqual(['work'])
    actor.store.setState({
      me: me('sam', {
        servers: [
          {
            name: 'club',
            display_name: 'Club',
            creator: null,
            is_admin: false,
            banner_color: null,
            icon_image: null,
            icon_kind: 'identicon' as const,
            name_color: null,
            profiles_mode: 'all' as const,
            timed_out_remaining: null,
            timed_out_until: null,
          },
        ],
      }),
      servers: {
        club: serverDetail('club', { channels: [{ ...textChannel(4), name: 'general' }] }),
      },
      openChannel: async () => {
        opened = actor.identities.coversView() ? 'peer' : 'instance'
      },
    })
    await flatItems(accountPaletteSections(actor, '#general', ctx))[0].run()
    expect(opened).toBe('instance')
  } finally {
    client.show(prev, 'none')
  }
})
