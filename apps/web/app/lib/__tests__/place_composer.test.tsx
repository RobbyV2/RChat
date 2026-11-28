import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerField, fits } from '../../components/composer_field'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import { composer, type ComposerList } from '../place/composer'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import type { RChatState } from '../store_types'
import type { View } from '../view'
import { msg, user } from './fixtures'
import { NO_THREADS_TEXT } from '../channel_perms'
import { ChannelPermBit } from '../types'
import { ReplyBar } from '../../components/replies'
import { ComposerGate } from '../../components/composer_gate'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with the conversation on screen and a thread open beside it, a draft in each, and
// what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], list: ComposerList = 'main') => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const view: View =
      place.kind === 'hostedServer'
        ? { kind: 'channel', server: world.server, channelId: 1 }
        : { kind: 'dm', dmId: world.dmId }
    const key = place.kind === 'hostedServer' ? 'c1' : `d${world.dmId}`
    const state = {
      view,
      panel: { kind: 'thread', root: msg(5) },
      drafts: { [key]: 'see you at noon', t5: 'in the thread' },
      me: { ...user('ann'), servers: [] },
      replying: { t5: { message: msg(6, { author: user('bob') }), mention: true } },
      setDraft: (...a: unknown[]) => void calls.push(['draft', ...a]),
      noteTyping: (...a: unknown[]) => void calls.push(['typing', ...a]),
      editLast: (k: string) => {
        calls.push(['edit', k])
        return true
      },
      cancelReply: (k: string) => void calls.push(['cancel', k]),
      toggleReplyMention: (k: string) => void calls.push(['ping', k]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const ch = place.kind === 'p2pRoom' ? 'c1' : null
    const main = ch ? `${world.room}/${ch}` : world.room
    const thread = `${main}#e5`
    const state = {
      chat: { room: world.room, ch },
      thread: {
        room: world.room,
        ch,
        root: 'e5',
        head: null,
        messages: [
          { id: 'e6', sender: 'B', ts: 6_000, body: 'six', att: [], reactions: [], edited: null },
        ],
        more: false,
        loading: false,
      },
      drafts: { [main]: 'see you at noon', [thread]: 'in the thread' },
      replying: { room: thread, id: 'e6' },
    }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pDm, {
      setDraft: (...a: unknown[]) => void calls.push(['draft', ...a]),
      typing: (...a: unknown[]) => void calls.push(['typing', ...a]),
      typingEvery: () => 4_000,
      editLast: (k: string) => {
        calls.push(['edit', k])
        return true
      },
      cancelReply: () => void calls.push(['cancel']),
    })
  }
  const here = featureAt(composer, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here.at(list)
}

placeContract(composer, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const mainKey = () =>
    hosted
      ? kind === 'hostedServer'
        ? 'c1'
        : `d${world().dmId}`
      : kind === 'p2pRoom'
        ? `${world().room}/c1`
        : world().room
  const threadKey = () => (hosted ? 't5' : `${mainKey()}#e5`)

  test('each list of the place has its own draft', () => {
    const main = seat(world(), [])
    const state = main.state.get()
    expect(main.state.get()).toBe(state)
    expect([state.key, state.text, state.replying]).toEqual([mainKey(), 'see you at noon', null])
    expect(state.max).toBeGreaterThan(0)
    const thread = seat(world(), [], 'thread').state.get()
    expect([thread.key, thread.text]).toEqual([threadKey(), 'in the thread'])
  })

  test('a draft that answers a message says whom, and whether they are pinged', () => {
    const calls: unknown[][] = []
    const thread = seat(world(), calls, 'thread')
    const { replying } = thread.state.get()
    expect(thread.state.get().replying).toBe(replying)
    expect(replying?.to.kind).toBe(hosted ? 'account' : 'named')
    expect(replying?.mention).toBe(hosted ? true : null)
    thread.toggleReplyMention()
    expect(calls).toEqual(hosted ? [['ping', threadKey()]] : [])
    const html = renderToStaticMarkup(
      <AccountProvider session={world().ann.account}>
        <P2pProvider identity={world().ann.app}>
          <PlaceProvider place={world().ann.place}>
            <ReplyBar list="thread" />
            <ReplyBar list="main" />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html.match(/Replying to/g)?.length).toBe(1)
    expect(html).toContain('aria-label="Cancel reply"')
    expect(html.includes('aria-pressed="true"')).toBe(hosted)
  })

  test('the draft, the last edit and the reply change on the side of the place', () => {
    const calls: unknown[][] = []
    const thread = seat(world(), calls, 'thread')
    thread.setText('later')
    expect(thread.editLast()).toBe(true)
    thread.cancelReply()
    expect(calls).toEqual([
      ['draft', threadKey(), 'later'],
      ['edit', threadKey()],
      hosted ? ['cancel', threadKey()] : ['cancel'],
    ])
  })

  test('a list asked to take the focus says so, and only that list', () => {
    const { ann } = world()
    const main = seat(world(), [])
    const thread = seat(world(), [], 'thread')
    expect(main.state.get().focus).toBe(0)
    const key = main.state.get().key as string
    if (hosted) ann.account.store.setState({ composerFocus: { key, n: 3 } })
    else ann.app?.useP2p.setState({ composerFocus: { key, n: 3 } })
    expect(main.state.get().focus).toBe(3)
    expect(thread.state.get().focus).toBe(0)
    if (hosted) return
    ann.app?.p2pDm.startReply(key, 'e6')
    expect(main.state.get().focus).toBe(4)
  })

  test('typing is said as often as the place wants it', () => {
    const calls: unknown[][] = []
    const main = seat(world(), calls)
    const key = mainKey()
    main.typing(key, true)
    main.typing(key, true)
    main.typing(key, false)
    expect(calls).toEqual(
      hosted
        ? [
            ['typing', key, true],
            ['typing', key, true],
            ['typing', key, false],
          ]
        : [
            ['typing', key, true],
            ['typing', key, false],
          ]
    )
  })

  test('a text fits by its count and, between identities, by its size', () => {
    const main = seat(world(), [])
    const { max } = main.state.get()
    expect(fits(main, 'a'.repeat(max), max)).toBe(true)
    expect(fits(main, 'a'.repeat(max + 1), max)).toBe(false)
  })

  test('one field draws either side', () => {
    const main = seat(world(), [])
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <ComposerField
              compose={main}
              listKey={null}
              placeholder="Message"
              slowLeft={0}
              bar={null}
              later={() => null}
              onSend={() => {}}
            />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('see you at noon')
    expect(html).toContain('aria-label="Emoji"')
    expect(html).toContain('aria-label="Send"')
  })

  // Ann as a member who may write here, then with `change` on her side of the place.
  const gated = (change: (hostedState: () => Partial<RChatState>) => void, peer: object = {}) => {
    const main = seat(world(), [])
    const { ann, server } = world()
    if (hosted) {
      const mine = { name: server, timed_out_until: undefined as number | undefined }
      const me = { ...user('ann'), servers: [mine] }
      ann.account.store.setState({ me } as never)
      change(() => ({ me: { ...me, servers: [{ ...mine }] } }) as never)
    } else if (ann.app) {
      const state = {
        reader: false,
        elsewhere: false,
        status: 'ready',
        movedAt: null,
        movingAt: null,
        contacts: [{ ik: 'B', name: 'Bob', state: 'mutual' }],
        rooms: { [world().room]: { peer: 'B', full: false } },
        ...(kind === 'p2pDm' ? { chat: { room: world().room, ch: null, peer: 'B' } } : {}),
        ...peer,
      }
      ann.app.useP2p.setState(state as never)
    }
    return main
  }
  const drawn = (main: ReturnType<typeof seat>) => {
    const { account, app } = world().ann
    Object.assign(account.store.getInitialState(), account.store.getState())
    if (app) Object.assign(app.useP2p.getInitialState(), app.useP2p.getState())
    return renderToStaticMarkup(
      <AccountProvider session={world().ann.account}>
        <P2pProvider identity={world().ann.app}>
          <ComposerGate compose={main} list="main" />
        </P2pProvider>
      </AccountProvider>
    )
  }

  test('a member who may write has an open composer', () => {
    const main = gated(() => {})
    const gate = main.gate.get()
    expect(main.gate.get()).toBe(gate)
    expect(gate).toEqual({ first: null, until: null, then: null })
    expect(drawn(main)).toBe('')
  })

  test('what holds the composer back is said in its place', () => {
    if (hosted) {
      const main = gated(() => {})
      const { ann, server } = world()
      if (kind === 'hostedDm') {
        ann.account.store.setState({ guest: true } as never)
        expect(main.gate.get().first?.kind).toBe('guest')
        expect(drawn(main)).toContain('data-guest-notice')
        return
      }
      ann.account.store.setState({ me: { ...user('ann'), servers: [] } } as never)
      expect(main.gate.get().first).toEqual({ kind: 'join', server, name: server })
      expect(drawn(main)).toContain('data-preview-bar')
      expect(drawn(main)).toContain('Join server')
      const until = Math.floor(Date.now() / 1000) + 600
      const mine = { name: server, timed_out_until: until }
      ann.account.store.setState({ me: { ...user('ann'), servers: [mine] } } as never)
      expect(main.gate.get()).toEqual({ first: null, until: until * 1000, then: null })
      expect(drawn(main)).toContain('data-timed-out')
      return
    }
    const away = gated(() => {}, { elsewhere: true })
    expect(away.gate.get().first).toEqual({ kind: 'elsewhere' })
    const moved = gated(() => {}, { status: 'moved', movedAt: 5 })
    expect(moved.gate.get().first).toEqual({ kind: 'moved', at: 5 })
    if (kind === 'p2pRoom') {
      const { ann, room } = world()
      const joined = (perms: number) => ({
        servers: {
          [room]: {
            id: room,
            me: 'join',
            members: [],
            channels: [{ id: 'c1', perms, send: true }],
          },
        },
        thread: { room, ch: 'c1', root: 'r1', loading: false, head: null, messages: [] },
      })
      const seen = ChannelPermBit.ViewChannels + ChannelPermBit.SendMessages
      gated(() => {}, joined(seen))
      const here = featureAt(composer, ann.place)
      if (isUnsupported(here)) throw new Error('a room has a composer')
      const thread = here.at('thread')
      expect(thread.gate.get().then).toEqual({ kind: 'noThreads' })
      expect(drawn(thread)).toContain(NO_THREADS_TEXT)
      ann.app?.useP2p.setState(joined(seen + ChannelPermBit.StartThreads) as never)
      expect(thread.gate.get().then).toBeNull()
    }
    if (kind === 'p2pDm') {
      const alone = gated(() => {}, { contacts: [] })
      expect(alone.gate.get().first).toEqual({ kind: 'noContact' })
      expect(drawn(alone)).toContain('This contact was removed.')
      const blocked = gated(() => {}, { contacts: [{ ik: 'B', name: 'Bob', state: 'blocked' }] })
      expect(blocked.gate.get().first?.kind).toBe('blocked')
      expect(drawn(blocked)).toContain('You blocked')
    }
  })
})
